// AO Eval Engine — ingest adapter (background path).
//
// The eval sweeper judges sessions that were INGESTED (not handed over via a
// request). A client attaches, at call end, a generic "agent config" record
// describing what the agent was configured to do, and tags each transcript
// chat item with an opaque `node_ref`. This module turns the stored config +
// transcript into the engine's neutral `ConversationInput`, runs the same
// node/goal engine + conversation judges the rest of the product uses, and
// returns a verdict object keyed by those opaque refs.
//
// Nothing here knows about any specific agent platform: the config shape is the
// public ingest contract, and `ref` is echoed back untouched so the caller can
// map verdicts to whatever node identity it uses.

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

// ── the public ingest "agent config" shape (what a client sends) ─────────────
// Every field optional + read defensively — a client owns its own serialization
// and AO must never throw on a shape it doesn't recognise (a bad config yields
// an empty evaluation, not a crash).

export interface AgentConfigVariable {
  name?: string;
  /** Recording rule for the variable (how/when it should be captured). */
  rule?: string;
}
export interface AgentConfigIntent {
  name?: string;
  description?: string;
}
export interface AgentConfigNode {
  /** Opaque per-node reference the caller correlates verdicts to (echoed back). */
  ref?: string;
  name?: string;
  instructions?: string;
  intents?: AgentConfigIntent[];
  variables?: AgentConfigVariable[];
}
export interface AgentConfigGoal {
  name?: string;
  instructions?: string;
}
export interface AgentConfig {
  flow_name?: string;
  global_prompt?: string;
  goals?: AgentConfigGoal[];
  nodes?: AgentConfigNode[];
}

// ── ingested transcript shape (raw_report.events, as AO stores them) ─────────
interface StoredEvent {
  type?: string;
  node_ref?: string;
  item?: {
    type?: string;
    role?: string;
    content?: unknown;
    name?: string; // function name (function_call / function_call_output)
    arguments?: unknown;
    output?: unknown;
  };
}

const USER_ROLES = new Set(["user", "customer", "human", "caller", "callee", "contact"]);

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : textOf((c as { text?: unknown })?.text))).filter(Boolean).join(" ").trim();
  }
  return "";
}

/** Render a tool/function event as a labelled evidence line the judges read as
 *  supporting evidence (a grounded value from a tool must not read as fabricated). */
function toolEvidence(item: NonNullable<StoredEvent["item"]>): string {
  const name = typeof item.name === "string" ? item.name : "tool";
  if (item.type === "function_call") {
    const args = item.arguments !== undefined ? JSON.stringify(item.arguments) : "";
    return `Tool_Call: ${name}(${args})`;
  }
  const out = item.output !== undefined ? (typeof item.output === "string" ? item.output : JSON.stringify(item.output)) : "";
  return `Tool_Result: ${name} -> ${out}`;
}

function nodeGoals(cfg: AgentConfig): GoalInput[] {
  const raw = Array.isArray(cfg.goals) ? cfg.goals : [];
  return raw
    .map((g): GoalInput | null => {
      const name = typeof g?.name === "string" ? g.name.trim() : "";
      if (!name) return null;
      return { goal_name: name, goal_instructions: typeof g.instructions === "string" ? g.instructions : "", flow_goal_id: 0 };
    })
    .filter((g): g is GoalInput => g !== null);
}

/** Parallel to the engine's `nodes`, in the same order: the opaque ref + name
 *  the caller needs to map each verdict back to its own node identity. */
export interface NodeRef {
  ref: string;
  name: string;
}

/**
 * Build the engine `ConversationInput` from a stored agent config + ingested
 * transcript events. Turns are grouped to config nodes by `node_ref` when the
 * transcript carries it; when it doesn't (e.g. a single-node agent), all turns
 * fall to the first configured node. Only nodes that actually saw a turn are
 * evaluated. Never throws.
 */
export function buildSessionEvalInput(
  config: AgentConfig,
  events: StoredEvent[],
): { input: ConversationInput; nodeRefs: NodeRef[] } {
  const cfgNodes = Array.isArray(config.nodes) ? config.nodes : [];
  const evs = Array.isArray(events) ? events : [];

  // Index config nodes by ref; keep declaration order for the fallback bucket.
  const byRef = new Map<string, AgentConfigNode>();
  cfgNodes.forEach((n) => { if (typeof n.ref === "string" && n.ref) byRef.set(n.ref, n); });
  const fallbackRef = typeof cfgNodes[0]?.ref === "string" ? cfgNodes[0].ref : "";

  // Group each transcript turn under a node ref, preserving chronological order.
  const turnsByRef = new Map<string, EvalTurn[]>();
  const orderedRefs: string[] = [];
  const pushTurn = (ref: string, turn: EvalTurn) => {
    if (!turnsByRef.has(ref)) { turnsByRef.set(ref, []); orderedRefs.push(ref); }
    turnsByRef.get(ref)!.push(turn);
  };

  for (const ev of evs) {
    if (ev?.type !== "conversation_item_added" || !ev.item) continue;
    const ref = (typeof ev.node_ref === "string" && ev.node_ref) ? ev.node_ref : fallbackRef;
    if (!ref) continue;
    const item = ev.item;
    if (item.type === "function_call" || item.type === "function_call_output") {
      pushTurn(ref, { node_uuid: ref, user: "", agent: toolEvidence(item), intent: "" });
      continue;
    }
    const text = textOf(item.content);
    if (!text) continue;
    const isUser = USER_ROLES.has((item.role ?? "").toLowerCase());
    pushTurn(ref, isUser
      ? { node_uuid: ref, user: text, agent: "", intent: "" }
      : { node_uuid: ref, user: "", agent: text, intent: "" });
  }

  const nodes: NodeEvalInput[] = [];
  const nodeRefs: NodeRef[] = [];
  const allTurns: EvalTurn[] = [];

  for (const ref of orderedRefs) {
    const turns = turnsByRef.get(ref) ?? [];
    if (turns.length === 0) continue;
    const def = byRef.get(ref) ?? cfgNodes[0] ?? {};
    const requiredVariables = (def.variables ?? [])
      .map((v) => v?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    const rules: Record<string, string> = {};
    for (const v of def.variables ?? []) {
      if (typeof v?.name === "string" && v.name && typeof v.rule === "string" && v.rule.trim()) rules[v.name] = v.rule.trim();
    }
    allTurns.push(...turns);
    nodes.push({
      node_uuid: ref,
      node_name: typeof def.name === "string" && def.name ? def.name : ref,
      node_prompt: typeof def.instructions === "string" ? def.instructions : "",
      available_intents: Array.isArray(def.intents) ? def.intents.map((i) => ({ intent_name: i?.name, intent_instructions: i?.description })) : [],
      chosen_intent: "",
      required_variables: requiredVariables,
      ...(Object.keys(rules).length ? { variable_rules: rules } : {}),
      extracted_variables: {},
      turns,
      turn_count: turns.length,
    });
    nodeRefs.push({ ref, name: typeof def.name === "string" ? def.name : ref });
  }

  return {
    input: {
      flow_name: typeof config.flow_name === "string" ? config.flow_name : "conversation",
      global_prompt: typeof config.global_prompt === "string" ? config.global_prompt : "",
      nodes,
      goals: nodeGoals(config),
      full_transcript: renderFullTranscript(allTurns),
    },
    nodeRefs,
  };
}

/** The verdict object the sweeper stores. Node evaluations are keyed by the
 *  caller's opaque `ref`; conversation_metrics + goals are whole-transcript. */
export interface SessionEvalVerdicts {
  node_evaluations: Array<NodeEvaluation & { ref: string }>;
  conversation_metrics: SimConversationMetrics;
  goal_evaluation?: NodeGoalEvaluation["goal_evaluation"];
}

/**
 * Judge one ingested session. Runs the node/goal engine and the conversation
 * judges over the built input, and re-attaches each node's opaque `ref`.
 * Throws on a node-judge failure (the caller records that as a terminal eval
 * error); the conversation judges are internally fault-tolerant.
 */
export async function evaluateIngestedSession(
  config: AgentConfig,
  events: StoredEvent[],
  provider?: LlmProvider,
): Promise<SessionEvalVerdicts> {
  const { input, nodeRefs } = buildSessionEvalInput(config, events);

  const [conversation_metrics, scored] = await Promise.all([
    input.full_transcript.trim()
      ? evaluateConversationMetrics(input, provider)
      : Promise.resolve(emptyConversationMetrics()),
    input.nodes.length
      ? evaluateSimulation(input, { provider })
      : Promise.resolve({ node_evaluations: [] } as NodeGoalEvaluation),
  ]);

  // evaluateSimulation preserves input.nodes order, so node_evaluations[i] ↔ nodeRefs[i].
  const node_evaluations = scored.node_evaluations.map((ne, i) => ({ ...ne, ref: nodeRefs[i]?.ref ?? "" }));

  return {
    node_evaluations,
    conversation_metrics,
    ...(scored.goal_evaluation ? { goal_evaluation: scored.goal_evaluation } : {}),
  };
}

function emptyConversationMetrics(): SimConversationMetrics {
  const det = () => ({ detected: false, detected_value: 0, reason: "", technical_reason: "" });
  return {
    answered: false,
    voicemail_detected: det(),
    bot_detected: det(),
    call_screening: det(),
    low_engagement: det(),
    wrong_number: det(),
    do_not_disturb: det(),
    user_sentiment: { sentiment: "", reason: "", technical_reason: "" },
    silent_call: false,
    customer_engaged: false,
    conversation_status: { status: "", reason: "", technical_reason: "" },
    is_livekit: true,
    is_agent_runner: false,
    stt: { error_count: 0, recovered_count: 0 },
  };
}
