import type { ConversationInput, NodeEvalInput } from "../types.js";
import type { CustomJudgeSpec } from "../judges/custom-metric.js";
import { isVoiceChannel } from "../judges/conversation-judges.js";
import { clipToolResults, estimateQuestionTokens, estimateRequestTokens } from "../../jev/tokens.js";
import { buildHallucinationState, residualClaims } from "../../jev/hallucination-grounding.js";
import {
  ADHERENCE_QUESTION,
  CONVERSATION_QUESTIONS,
  HALLUCINATION_QUESTIONS,
  MAX_CLAIM_QUESTIONS,
  MAX_INTENT_QUESTIONS,
  MAX_VARIABLE_QUESTIONS,
  NODE_LOOP_QUESTION,
  claimQuestion,
  customMetricQuestions,
  intentQuestions,
  variableQuestions,
} from "../../jev/questions.js";
import type { JevNoul, JevRequest } from "../../jev/types.js";

// What to ask Jev about one session, and over which states.
//
// Shape follows the benchmark exactly (spec §3): a speech-only conversation
// request, and per node a config+transcript request (loop / adherence /
// intents), a variables request over the same state, and a compact grounded
// request for hallucination. They are purpose-built because that is what the
// gates were calibrated on — merging them into one state was measured to move
// hallucination probabilities by up to 0.46 (context rot), which the gates
// would not survive. All requests go out together, so it is still one round trip.
//
// An axis the plan does NOT ask about is not a decision: the caller runs the
// judge that owns it, exactly as today. That is how the neutral-skip paths
// (no intents / no variables / no node prompt / empty transcript) stay
// byte-identical — those judges return their neutral verdict with no LLM call.

export const CONVERSATION_JUDGES = [
  "voicemail_detection",
  "bot_detection",
  "call_screening",
  "low_engagement",
  "wrong_number",
  "do_not_disturb",
] as const;
export type ConversationJudgeName = (typeof CONVERSATION_JUDGES)[number];

/** Voice-only by the same rule the LLM path uses (conversation-judges.ts). */
export const VOICE_ONLY: ReadonlySet<string> = new Set(["voicemail_detection", "bot_detection", "call_screening"]);

export const NODE_JUDGES = [
  "node_loop",
  "instructions_adherence",
  "intent_identification",
  "variable_extraction",
  "hallucination",
] as const;
export type NodeJudgeName = (typeof NODE_JUDGES)[number];

/** Every judge Jev CAN answer. */
export const ALL_JEV_JUDGES: readonly string[] = [...CONVERSATION_JUDGES, ...NODE_JUDGES];

/** What "all" means: every judge Jev answers by default. */
export const DEFAULT_JEV_JUDGES: readonly string[] = ALL_JEV_JUDGES;

export interface JevIntentQuestionRef {
  key: string;
  intent: string;
}
export interface JevVariableQuestionRef {
  key: string;
  variable: string;
  recorded: boolean;
}

interface JevAxisCommon {
  /** Stable id used as the map key everywhere downstream. */
  id: string;
  judge: string;
  requestKey: string;
  questionKeys: string[];
  /** Set on the axes that belong to one node. */
  nodeIndex?: number;
}
export interface JevConversationAxis extends JevAxisCommon {
  kind: "conversation";
  judge: ConversationJudgeName;
}
export interface JevNodeAxis extends JevAxisCommon {
  kind: "node";
  judge: NodeJudgeName;
  nodeIndex: number;
  intents?: JevIntentQuestionRef[];
  variables?: JevVariableQuestionRef[];
  /** The node declares more intents/variables than the caps allow, so the
   *  questions do not cover the whole surface: the unasked ones can never fire
   *  and must not be read as clean. */
  truncated?: boolean;
}
export interface JevCustomAxis extends JevAxisCommon {
  kind: "custom";
  judge: string;
  scope: "conversation" | "node";
  applicableKey: string;
  failKey: string;
}
export type JevAxis = JevConversationAxis | JevNodeAxis | JevCustomAxis;

export interface JevPlan {
  requests: JevRequest[];
  axes: JevAxis[];
  /** Requests that were never sent because their state exceeded the budget;
   *  their axes fall back to the LLM judge. */
  dropped: Array<{ requestKey: string; estTokens: number }>;
}

export interface BuildJevPlanOptions {
  /** Allow-list of judges Jev may answer; omitted means DEFAULT_JEV_JUDGES. */
  judges?: readonly string[];
  customSpecs?: readonly CustomJudgeSpec[];
  customEnabled?: boolean;
  budgetTokens?: number;
}

export const DEFAULT_BUDGET_TOKENS = 30_000;
/** Jev's total-context limit is twice its state limit (64k vs 32k), so the
 *  all-questions budget scales with the configured state budget. */
const TOTAL_BUDGET_MULTIPLE = 2;
/** Variable questions per request (the calibrated batch size). */
export const VARIABLE_QUESTIONS_PER_REQUEST = 8;

/**
 * The node state: the complete node config (full prompt, every intent with its
 * description and tool, every declared variable with its recording rule, the
 * global prompt and variables) plus what the agent chose and recorded, and the
 * conversation with over-long tool output clipped.
 *
 * Field names and contents are the ones the gates were calibrated against — Jev
 * reads the state's keys, so renaming or adding a field is a behaviour change,
 * not a refactor. Measured: adding the per-node transcript alongside the full
 * conversation moved probabilities enough to change gate bands.
 */
export function jevNodeState(node: NodeEvalInput, ctx: ConversationInput): Record<string, unknown> {
  const intents = (node.available_intents ?? []).map((raw) => {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const name = String(o.intent_name ?? o.name ?? "");
    return { name, tool: node.intent_tools?.[name] ?? null, description: o.intent_instructions ?? o.description ?? null };
  });
  return {
    global_prompt: ctx.global_prompt ?? "",
    global_variables: ctx.global_variables ?? {},
    node_name: node.node_name,
    node_prompt: node.node_prompt ?? "",
    available_intents: intents,
    declared_variables: (node.required_variables ?? []).map((name) => ({
      name,
      rule: node.variable_rules?.[name] ?? null,
    })),
    chosen_intent: node.chosen_intent,
    extracted_variables: node.extracted_variables ?? {},
    conversation_history: clipToolResults(ctx.full_transcript ?? ""),
  };
}

/** The conversation state is the speech-only transcript itself: the detections
 *  classify what was SAID, and wrapping it in an object was measured to change
 *  their answers (low engagement most of all). */
export function jevConversationState(ctx: ConversationInput): string {
  return clipToolResults(ctx.speech_transcript || ctx.full_transcript);
}

function judgeAllowed(judges: BuildJevPlanOptions["judges"], judge: string): boolean {
  return (judges ?? DEFAULT_JEV_JUDGES).includes(judge);
}

/** "all" or a comma-separated list; unknown names are reported so a typo in
 *  JEV_JUDGES cannot silently leave a judge on the LLM path. */
export function parseJevJudges(raw: string | undefined): { judges: readonly string[]; unknown: string[] } {
  const value = (raw ?? "all").trim();
  if (!value || value === "all") return { judges: DEFAULT_JEV_JUDGES, unknown: [] };
  const names = value.split(",").map((n) => n.trim()).filter(Boolean);
  return { judges: names.filter((n) => ALL_JEV_JUDGES.includes(n)), unknown: names.filter((n) => !ALL_JEV_JUDGES.includes(n)) };
}

export function buildJevPlan(ctx: ConversationInput, opts: BuildJevPlanOptions = {}): JevPlan {
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const requests: JevRequest[] = [];
  const axes: JevAxis[] = [];
  const dropped: Array<{ requestKey: string; estTokens: number }> = [];

  // A request is planned once its questions exist; it is SENT only if its state
  // fits. Axes of a dropped request stay in the plan so the caller still judges
  // them — on the LLM path.
  const addRequest = (key: string, state: unknown, questions: Record<string, JevNoul>, pending: JevAxis[]): void => {
    if (Object.keys(questions).length === 0) return;
    const est = estimateRequestTokens(state, questions);
    axes.push(...pending);
    // Both of Jev's limits, with the budget expressed against the tighter one.
    if (est.longest > budget || est.total > budget * TOTAL_BUDGET_MULTIPLE) {
      dropped.push({ requestKey: key, estTokens: est.longest });
      return;
    }
    requests.push({ key, state, questions, estTokens: est.longest, estTotalTokens: est.total });
  };

  const hasTranscript = !!ctx.full_transcript?.trim();
  const voice = isVoiceChannel(ctx.transport);
  const longestHallucinationQuestion = Math.max(
    ...Object.values(HALLUCINATION_QUESTIONS).map((q) => estimateQuestionTokens(q)),
  );

  // ── conversation axis ──────────────────────────────────────────────────────
  if (hasTranscript) {
    const questions: Record<string, JevNoul> = {};
    const pending: JevAxis[] = [];
    for (const judge of CONVERSATION_JUDGES) {
      if (!judgeAllowed(opts.judges, judge)) continue;
      // Never asked on a text channel, so no row can be fabricated there.
      if (!voice && VOICE_ONLY.has(judge)) continue;
      const key = `c.${judge}`;
      questions[key] = CONVERSATION_QUESTIONS[judge]!;
      pending.push({ kind: "conversation", id: key, judge, requestKey: "c", questionKeys: [key] });
    }
    addRequest("c", jevConversationState(ctx), questions, pending);
  }

  const nodes = ctx.nodes ?? [];
  const clippedTranscript = clipToolResults(ctx.full_transcript ?? "");
  // Everything the hallucination questions ground against depends on the CALL,
  // not the node, so a multi-node session retrieves it once.
  const claims = hasTranscript ? residualClaims(ctx, clippedTranscript, MAX_CLAIM_QUESTIONS) : [];

  nodes.forEach((node, nodeIndex) => {
    const state = jevNodeState(node, ctx);
    const prefix = `n${nodeIndex}`;

    // loop + adherence + intents share the node state
    const nodeQuestions: Record<string, JevNoul> = {};
    const nodeAxes: JevAxis[] = [];
    if (judgeAllowed(opts.judges, "node_loop")) {
      const key = `${prefix}.node_loop`;
      nodeQuestions[key] = NODE_LOOP_QUESTION;
      nodeAxes.push({ kind: "node", id: `${prefix}:node_loop`, judge: "node_loop", nodeIndex, requestKey: prefix, questionKeys: [key] });
    }
    // An empty node prompt is a neutral skip on the LLM path (no call, no
    // verdict to disagree with) — asking Jev would invent one.
    if (judgeAllowed(opts.judges, "instructions_adherence") && (node.node_prompt ?? "").trim()) {
      const key = `${prefix}.instructions_adherence`;
      nodeQuestions[key] = ADHERENCE_QUESTION;
      nodeAxes.push({ kind: "node", id: `${prefix}:instructions_adherence`, judge: "instructions_adherence", nodeIndex, requestKey: prefix, questionKeys: [key] });
    }
    if (judgeAllowed(opts.judges, "intent_identification")) {
      const intents = intentQuestions(node);
      if (intents.length > 0) {
        const refs: JevIntentQuestionRef[] = [];
        for (const { key, question, intent } of intents) {
          const full = `${prefix}.${key}`;
          nodeQuestions[full] = question;
          refs.push({ key: full, intent });
        }
        nodeAxes.push({
          kind: "node", id: `${prefix}:intent_identification`, judge: "intent_identification", nodeIndex,
          requestKey: prefix, questionKeys: refs.map((r) => r.key), intents: refs,
          ...((node.available_intents?.length ?? 0) > MAX_INTENT_QUESTIONS ? { truncated: true } : {}),
        });
      }
    }
    addRequest(prefix, state, nodeQuestions, nodeAxes);

    if (judgeAllowed(opts.judges, "variable_extraction")) {
      const vars = variableQuestions(node);
      if (vars.length > 0) {
        // Chunked, as calibrated: a full recording rule per variable is a long
        // question, and asking twenty of them over one state measurably dilutes
        // the answers (and can breach the state + longest-question limit).
        for (let start = 0; start < vars.length; start += VARIABLE_QUESTIONS_PER_REQUEST) {
          const chunk = vars.slice(start, start + VARIABLE_QUESTIONS_PER_REQUEST);
          const requestKey = `v${nodeIndex}.${start / VARIABLE_QUESTIONS_PER_REQUEST}`;
          const questions: Record<string, JevNoul> = {};
          const refs: JevVariableQuestionRef[] = [];
          for (const { key, question, variable, recorded } of chunk) {
            const full = `${requestKey}.${key}`;
            questions[full] = question;
            refs.push({ key: full, variable, recorded });
          }
          addRequest(requestKey, state, questions, [{
            kind: "node", id: `${prefix}:variable_extraction#${start / VARIABLE_QUESTIONS_PER_REQUEST}`,
            judge: "variable_extraction", nodeIndex,
            requestKey, questionKeys: refs.map((r) => r.key), variables: refs,
            ...((node.required_variables?.length ?? 0) > MAX_VARIABLE_QUESTIONS ? { truncated: true } : {}),
          }]);
        }
      }
    }

    // hallucination: its own compact grounded state (config windows around what
    // the agent actually said) plus one question per value code cannot ground.
    if (judgeAllowed(opts.judges, "hallucination")) {
      // Shed against the budget this plan is actually held to, minus the
      // longest question that will ride with the state.
      const { state: hState, agentLines } = buildHallucinationState(ctx, node, clippedTranscript, budget - longestHallucinationQuestion);
      if (agentLines.length > 0) {
        const questions: Record<string, JevNoul> = {};
        const keys: string[] = [];
        for (const [name, question] of Object.entries(HALLUCINATION_QUESTIONS)) {
          const full = `h${nodeIndex}.${name}`;
          questions[full] = question;
          keys.push(full);
        }
        claims.forEach((claim, i) => {
          const full = `h${nodeIndex}.claim.${i}`;
          questions[full] = claimQuestion(claim.token, claim.line);
          keys.push(full);
        });
        addRequest(`h${nodeIndex}`, hState, questions, [{
          kind: "node", id: `${prefix}:hallucination`, judge: "hallucination", nodeIndex,
          requestKey: `h${nodeIndex}`, questionKeys: keys,
        }]);
      }
    }
  });

  // ── custom metrics (off until measured in dev) ─────────────────────────────
  if (opts.customEnabled && hasTranscript) {
    for (const spec of opts.customSpecs ?? []) {
      const { applicable, fail } = customMetricQuestions(spec);
      if (spec.scope === "conversation") {
        const requestKey = `m.${spec.name}`;
        const applicableKey = `${requestKey}.applicable`;
        const failKey = `${requestKey}.fail`;
        addRequest(
          requestKey,
          {
            metric_name: spec.display_name,
            flow_name: ctx.flow_name,
            global_prompt: ctx.global_prompt,
            // Full transcript (not speech-only): a custom metric often judges
            // tool behaviour, the same reason its LLM judge gets the full one.
            conversation_history: clippedTranscript,
            ...(ctx.global_variables && Object.keys(ctx.global_variables).length > 0 ? { global_variables: ctx.global_variables } : {}),
          },
          { [applicableKey]: applicable, [failKey]: fail },
          [{ kind: "custom", id: requestKey, judge: spec.name, scope: "conversation", requestKey, questionKeys: [applicableKey, failKey], applicableKey, failKey }],
        );
        continue;
      }
      nodes.forEach((node, nodeIndex) => {
        const requestKey = `m${nodeIndex}.${spec.name}`;
        const applicableKey = `${requestKey}.applicable`;
        const failKey = `${requestKey}.fail`;
        addRequest(
          requestKey,
          { metric_name: spec.display_name, ...jevNodeState(node, ctx) },
          { [applicableKey]: applicable, [failKey]: fail },
          [{ kind: "custom", id: requestKey, judge: spec.name, scope: "node", nodeIndex, requestKey, questionKeys: [applicableKey, failKey], applicableKey, failKey }],
        );
      });
    }
  }

  return { requests, axes, dropped };
}
