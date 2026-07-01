// AO Eval Engine — cx-sqs-worker "Option A" redirect adapter (LIVE calls).
//
// cx-sqs-worker assembles a completed real call as its own `ConversationInput`
// (`{ flow_definition, flow_run }` with a per-speaker `node_run_history`) and, when
// `EVAL_ENGINE=ao`, POSTs it to this server instead of running its Go evaluator. This
// module maps that payload onto the eval-engine's `ConversationInput`, runs the
// node+goal evaluator, and wraps the result back into cx's `ConversationEvaluationOutput`
// so the worker's persistence path + the console render unchanged.
//
// This is the LIVE counterpart of `sim-adapter.ts` (which feeds the engine from a
// simulation transcript). Both converge on the same `evaluateSimulation` core and the
// same cx-compatible output shape. Coverage here is the engine's Phase-1 axes (node +
// goal); the conversation axis (sentiment/bot/voicemail/STT/TD) is Phase 2 and is
// emitted as the all-default `conversation_metrics` block, exactly as cx-sqs does when
// `SkipConversationEval=true`.

import type { LlmProvider } from "../../llm/index.js";
import { renderFullTranscript } from "../conversation-input.js";
import { evaluateSimulation } from "../evaluator.js";
import { evaluateConversationMetrics } from "../judges/conversation-judges.js";
import type {
  ConversationInput,
  EvalTurn,
  GoalInput,
  NodeEvalInput,
  NodeEvaluation,
  NodeGoalEvaluation,
  SimConversationMetrics,
} from "../types.js";

// ── cx-sqs-worker payload shapes (the subset this adapter reads) ─────────────
// Mirrors cx-sqs-worker `models/eval.go` (ConversationInput / FlowDefinition /
// FlowRun / NodeRunEntry / Turn). Every field is optional + defensively read: the
// worker owns the canonical struct, and we must never throw on a shape we don't
// recognise (a bad payload yields an empty evaluation, not a 500 loop).

export interface CxTurn {
  speaker?: string;
  message?: string;
  is_system_message?: boolean;
  variables?: Record<string, unknown> | null;
}

export interface CxNodeRunEntry {
  node_uuid?: string;
  node_run_uuid?: string;
  node_run_key?: string;
  node_name?: string;
  node_type?: string;
  chosen_intent?: string | null;
  data?: { turns?: CxTurn[] } | null;
}

export interface CxNodeDefinition {
  prompt?: string;
  intents?: unknown[];
  extract_variables?: Array<{ variable_name?: string }>;
}

export interface CxGoalDefinition {
  id?: number;
  goal_name?: string;
  goal_instructions?: string;
}

export interface CxFlowDefinition {
  flow_uuid?: string;
  flow_name?: string;
  global_prompt?: string;
  nodes?: Record<string, CxNodeDefinition>;
  goals?: CxGoalDefinition[];
}

export interface CxFlowRun {
  channel?: string;
  run_uuid?: string;
  node_run_history?: CxNodeRunEntry[];
}

export interface CxConversationInput {
  flow_definition?: CxFlowDefinition;
  flow_run?: CxFlowRun;
}

/** cx `ConversationEvaluation` (models/eval.go) — the `evaluation` payload the worker
 *  persists to `conversation_run_summary.node_metrics` and the console renders. Reuses
 *  the engine's Phase-1 result type (node + goal) verbatim; the engine's own types are
 *  key-compatible with cx, so no field remapping is needed. */
export interface CxConversationEvaluation extends Omit<NodeGoalEvaluation, "node_evaluations"> {
  flow_uuid: string;
  flow_name: string;
  run_uuid: string;
  conversation_metrics: SimConversationMetrics;
  /** Engine node_evaluations enriched with the cx node_run_uuid / node_run_key the
   *  console matches executed nodes on (the engine's NodeEvaluation is keyed by
   *  node_uuid only, which the eye button can't match). */
  node_evaluations: Array<NodeEvaluation & CxNodeRef>;
}

/** cx `ConversationEvaluationOutput` — the exact top-level JSON the worker unmarshals. */
export interface CxConversationEvaluationOutput {
  conversation: CxConversationInput;
  evaluation: CxConversationEvaluation;
}

// ── constants ────────────────────────────────────────────────────────────────

/** Speakers that map to the user side of an exchange (everything else is the agent). */
const USER_SPEAKERS = new Set(["user", "customer", "human", "caller", "callee", "contact"]);

/** Node types cx-sqs-worker's transformer treats as non-evaluable (no LLM node judging).
 *  Anything not in this set + carrying turns is treated as an AI node. */
const SKIP_NODE_TYPES = new Set([
  "start",
  "http_request",
  "http",
  "webhook",
  "hangup",
  "end",
  "transfer",
  "handoff_only",
  "conditional",
  "condition",
  "set_variable",
]);

// ── helpers ───────────────────────────────────────────────────────────────────

function isUser(speaker: string | undefined): boolean {
  return USER_SPEAKERS.has((speaker ?? "").trim().toLowerCase());
}

function turnsOf(entry: CxNodeRunEntry): CxTurn[] {
  const turns = entry.data?.turns;
  return Array.isArray(turns) ? turns : [];
}

/** Convert a node's per-speaker cx turns into the engine's `EvalTurn[]`, one turn per
 * utterance, in order.
 *
 * The engine renders a turn as its `User:` line then its `Agent:` line (both in
 * `full_transcript` and the per-node history the judges read). Emitting one one-sided
 * turn per utterance therefore reproduces the exact chronological transcript with no
 * reordering — important because voice calls are agent-led (the agent greets first),
 * so any user+agent "pairing" would mis-order the greeting. System/boilerplate turns
 * (idle-hangup, reminders) and empty messages are dropped — feeding idle prompts as
 * agent speech is what made the loop judge over-fire. Per-turn intent is left empty;
 * the node-level `chosen_intent` is carried on `NodeEvalInput` instead.
 */
function buildTurns(nodeUuid: string, cxTurns: CxTurn[]): EvalTurn[] {
  const out: EvalTurn[] = [];
  for (const t of cxTurns) {
    if (t.is_system_message) continue;
    const msg = (t.message ?? "").trim();
    if (!msg) continue;
    if (isUser(t.speaker)) {
      out.push({ node_uuid: nodeUuid, user: msg, agent: "", intent: "" });
    } else {
      out.push({ node_uuid: nodeUuid, user: "", agent: msg, intent: "" });
    }
  }
  return out;
}

/** Union of every non-empty `variables` map recorded across a node's turns. */
function extractedVariables(cxTurns: CxTurn[]): Record<string, unknown> {
  const acc: Record<string, unknown> = {};
  for (const t of cxTurns) {
    const v = t.variables;
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        if (val !== null && val !== undefined && val !== "") acc[k] = val;
      }
    }
  }
  return acc;
}

function requiredVariables(def: CxNodeDefinition | undefined): string[] {
  const ev = def?.extract_variables;
  if (!Array.isArray(ev)) return [];
  return ev
    .map((v) => v?.variable_name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

function readGoals(def: CxFlowDefinition): GoalInput[] {
  const raw = def.goals;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((g): GoalInput | null => {
      const name = typeof g?.goal_name === "string" ? g.goal_name : "";
      if (!name) return null;
      return {
        goal_name: name,
        goal_instructions: typeof g.goal_instructions === "string" ? g.goal_instructions : "",
        flow_goal_id: typeof g.id === "number" ? g.id : Number(g.id) || 0,
      };
    })
    .filter((g): g is GoalInput => g !== null);
}

/** cx-sqs emits an all-default ConversationLevelMetrics under SkipConversationEval; we
 *  mirror it for raw-JSON parity (Phase 2 populates the real conversation axis). */
function defaultConversationMetrics(): SimConversationMetrics {
  const det = () => ({ detected: false, detected_value: 0, reason: "", technical_reason: "" });
  return {
    answered: false,
    voicemail_detected: det(),
    cx_voicemail_detected: 0,
    cx_call_screening_detected: 0,
    bot_detected: det(),
    call_screening: det(),
    low_engagement: det(),
    wrong_number: det(),
    do_not_disturb: det(),
    user_sentiment: { sentiment: "", reason: "", technical_reason: "" },
    silent_call: false,
    customer_engaged: false,
    conversation_status: { status: "", reason: "", technical_reason: "" },
    is_livekit: false,
    is_agent_runner: false,
    stt: { error_count: 0, recovered_count: 0 },
  };
}

// ── the adapter ─────────────────────────────────────────────────────────────

/** Per-node cx identifiers the eval engine drops (its NodeEvaluation is keyed by
 *  node_uuid only) but the console needs: it matches node_evaluations to executed
 *  nodes by `node_run_uuid`. Collected parallel to `input.nodes` so we can re-attach
 *  them to the engine's output by index. */
export interface CxNodeRef {
  node_run_uuid: string;
  node_run_key: string;
}

/**
 * Build the eval-engine `ConversationInput` from a cx-sqs-worker `ConversationInput`
 * (live call), plus the parallel `nodeRefs` (node_run_uuid / node_run_key per node,
 * in the same order as `input.nodes`). Only evaluable AI nodes are included: an entry
 * must have a matching node definition, carry ≥1 real turn, and not be a skip type.
 */
export function buildCxEvalInput(cx: CxConversationInput): {
  input: ConversationInput;
  nodeRefs: CxNodeRef[];
} {
  const def = cx.flow_definition ?? {};
  const run = cx.flow_run ?? {};
  const defNodes = def.nodes ?? {};
  const history = Array.isArray(run.node_run_history) ? run.node_run_history : [];

  const nodes: NodeEvalInput[] = [];
  const nodeRefs: CxNodeRef[] = [];
  const allTurns: EvalTurn[] = [];

  for (const entry of history) {
    const nodeUuid = entry.node_uuid ?? "";
    const nodeDef = defNodes[nodeUuid];
    if (!nodeUuid || !nodeDef) continue; // no config → not an evaluable node
    if (SKIP_NODE_TYPES.has((entry.node_type ?? "").toLowerCase())) continue;

    const cxTurns = turnsOf(entry);
    const turns = buildTurns(nodeUuid, cxTurns);
    if (turns.length === 0) continue; // nothing was said at this node

    allTurns.push(...turns);
    nodes.push({
      node_uuid: nodeUuid,
      node_name: entry.node_name || nodeUuid,
      node_prompt: typeof nodeDef.prompt === "string" ? nodeDef.prompt : "",
      available_intents: Array.isArray(nodeDef.intents) ? nodeDef.intents : [],
      chosen_intent: typeof entry.chosen_intent === "string" ? entry.chosen_intent : "",
      required_variables: requiredVariables(nodeDef),
      extracted_variables: extractedVariables(cxTurns),
      turns,
      turn_count: turns.length,
    });
    nodeRefs.push({
      node_run_uuid: typeof entry.node_run_uuid === "string" ? entry.node_run_uuid : "",
      node_run_key: typeof entry.node_run_key === "string" ? entry.node_run_key : "",
    });
  }

  return {
    input: {
      flow_name: typeof def.flow_name === "string" ? def.flow_name : "conversation",
      global_prompt: typeof def.global_prompt === "string" ? def.global_prompt : "",
      nodes,
      goals: readGoals(def),
      full_transcript: renderFullTranscript(allTurns),
    },
    nodeRefs,
  };
}

/** Convenience wrapper returning just the engine input (used by unit tests). */
export function fromCxConversationInput(cx: CxConversationInput): ConversationInput {
  return buildCxEvalInput(cx).input;
}

export interface EvaluateCxRedirectOpts {
  /** Test injection; prod resolves the provider from env inside completeJSON. */
  provider?: LlmProvider;
}

/**
 * Run the node+goal evaluator on a cx redirect payload and return the cx
 * `ConversationEvaluationOutput` the worker persists. Throws on judge failure — the
 * HTTP route converts that to a 5xx so the worker requeues (same contract as the
 * Go evaluator returning an error → SQS retry).
 *
 * A payload with no evaluable AI nodes yields an empty (but well-formed) output —
 * never an error — mirroring cx-sqs returning an empty node_evaluations set.
 */
export async function evaluateCxRedirect(
  cx: CxConversationInput,
  opts: EvaluateCxRedirectOpts = {},
): Promise<CxConversationEvaluationOutput> {
  const { input, nodeRefs } = buildCxEvalInput(cx);
  const flowUuid = cx.flow_definition?.flow_uuid ?? "";
  const runUuid = cx.flow_run?.run_uuid ?? "";

  // Conversation axis (this module's port) and node+goal axis (the engine) are
  // independent — run them together. Conversation judges are internally fault-tolerant;
  // a node judge failure rejects evaluateSimulation → the route returns 5xx → requeue.
  const [conversation_metrics, scored] = await Promise.all([
    input.full_transcript.trim()
      ? evaluateConversationMetrics(input, opts.provider)
      : Promise.resolve(defaultConversationMetrics()),
    input.nodes.length
      ? evaluateSimulation(input, { provider: opts.provider })
      : Promise.resolve({ node_evaluations: [] } as NodeGoalEvaluation),
  ]);

  // evaluateSimulation preserves order (input.nodes.map), so node_evaluations[i]
  // corresponds to nodeRefs[i] — re-attach the cx node_run_uuid / node_run_key the
  // console matches on (the engine drops them).
  const node_evaluations = scored.node_evaluations.map((ne, i) => ({
    ...ne,
    node_run_uuid: nodeRefs[i]?.node_run_uuid ?? "",
    node_run_key: nodeRefs[i]?.node_run_key ?? "",
  }));

  // Assemble in cx ConversationEvaluation key order: header → conversation_metrics → node → goal.
  return {
    conversation: cx,
    evaluation: {
      flow_uuid: flowUuid,
      flow_name: input.flow_name,
      run_uuid: runUuid,
      conversation_metrics,
      node_evaluations,
      ...(scored.goal_evaluation ? { goal_evaluation: scored.goal_evaluation } : {}),
    },
  };
}
