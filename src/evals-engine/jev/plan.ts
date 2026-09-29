import type { ConversationInput, NodeEvalInput } from "../types.js";
import type { CustomJudgeSpec } from "../judges/custom-metric.js";
import { isVoiceChannel } from "../judges/conversation-judges.js";
import { clipToolResults, estimateQuestionTokens, estimateRequestTokens } from "../../jev/tokens.js";
import { buildHallucinationState, residualClaims } from "../../jev/hallucination-grounding.js";
import {
  ADHERENCE_QUESTIONS,
  CONVERSATION_QUESTIONS,
  HALLUCINATION_QUESTIONS,
  MAX_CLAIM_QUESTIONS,
  MAX_VARIABLE_QUESTIONS,
  NODE_LOOP_QUESTION,
  claimQuestion,
  customMetricQuestions,
  intentQuestions,
  variableQuestions,
} from "../../jev/questions.js";
import { prepareEvidence, nodeEvidence, type PreparedEvidence } from "./evidence.js";
import type { JevNoul, JevRequest } from "../../jev/types.js";
import { contextThroughNodeExit } from "../node-evidence.js";

// Plan independent questions over explicit evidence views. Only requests with
// byte-identical states may share a batch. Changed node views stay under LLM
// review until separately calibrated (policy.ts).

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
  /** An intent tool fired in this node, so the intent may be premature. */
  intentFired?: boolean;
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

const INTENT_STATE_KEYS = [
  "node_name", "available_intents", "chosen_intent", "evidence_version", "target_node_uuid", "scope",
  "chronology_available", "node_boundary", "node_transcript", "conversation_history",
];

export const DEFAULT_BUDGET_TOKENS = 30_000;
/** Jev's total-context limit is twice its state limit (64k vs 32k), so the
 *  all-questions budget scales with the configured state budget. */
const TOTAL_BUDGET_MULTIPLE = 2;
/** Logical chunk size for complete-coverage reduction; packing may combine chunks. */
export const VARIABLE_QUESTIONS_PER_REQUEST = 8;

/** Complete node configuration plus an explicit target and owned evidence. */
export function jevNodeState(node: NodeEvalInput, ctx: ConversationInput, evidence: PreparedEvidence = prepareEvidence(ctx), loop = false): Record<string, unknown> {
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
    ...(node.variable_sources ? { variable_sources: node.variable_sources } : {}),
    ...nodeEvidence(node, evidence, loop),
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
  const evidence = prepareEvidence(ctx);
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
    // Share state tokens only when the evidence is identical and both limits fit.
    const signature = JSON.stringify(state);
    const sameState = requests.find(r => JSON.stringify(r.state) === signature &&
      estimateRequestTokens(state, { ...r.questions, ...questions }).total <= budget * TOTAL_BUDGET_MULTIPLE);
    if (sameState) {
      Object.assign(sameState.questions, questions);
      const combined = estimateRequestTokens(state, sameState.questions);
      sameState.estTokens = combined.longest;
      sameState.estTotalTokens = combined.total;
      for (const axis of pending) axis.requestKey = sameState.key;
    } else {
      requests.push({ key, state, questions, estTokens: est.longest, estTotalTokens: est.total });
    }
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
  const clippedTranscript = evidence.fullTranscript;

  nodes.forEach((node, nodeIndex) => {
    const state = jevNodeState(node, ctx, evidence);
    const targetTranscript = evidence.nodes.get(node)!.transcript;
    const groundingContext = contextThroughNodeExit(node, ctx);
    const groundingTranscript = clipToolResults(groundingContext.full_transcript);
    const claims = hasTranscript ? residualClaims(groundingContext, groundingTranscript, MAX_CLAIM_QUESTIONS, targetTranscript) : [];
    const prefix = `n${nodeIndex}`;

    // loop and variable questions share the node state
    const nodeQuestions: Record<string, JevNoul> = {};
    const nodeAxes: JevAxis[] = [];
    if (judgeAllowed(opts.judges, "node_loop")) {
      const key = `${prefix}.node_loop`;
      const loopState = { ...state, ...nodeEvidence(node, evidence, true) };
      if (JSON.stringify(loopState) === JSON.stringify(state)) {
        nodeQuestions[key] = NODE_LOOP_QUESTION;
        nodeAxes.push({ kind: "node", id: `${prefix}:node_loop`, judge: "node_loop", nodeIndex, requestKey: prefix, questionKeys: [key] });
      } else {
        addRequest(`l${nodeIndex}`, loopState, { [key]: NODE_LOOP_QUESTION }, [{
          kind: "node", id: `${prefix}:node_loop`, judge: "node_loop", nodeIndex, requestKey: `l${nodeIndex}`, questionKeys: [key],
        }]);
      }
    }
    // An empty node prompt is a neutral skip on the LLM path (no call, no
    // verdict to disagree with) — asking Jev would invent one. Adherence gets
    // its own request without the intent catalog, the same view the LLM
    // adherence judge has: intent descriptions read as mandatory steps.
    if (judgeAllowed(opts.judges, "instructions_adherence") && (node.node_prompt ?? "").trim()) {
      const requestKey = `a${nodeIndex}`;
      const { available_intents: _routingOnly, ...adherenceState } = state;
      const questions: Record<string, JevNoul> = {};
      for (const [name, question] of Object.entries(ADHERENCE_QUESTIONS)) questions[`${requestKey}.${name}`] = question;
      addRequest(requestKey, adherenceState, questions, [{
        kind: "node", id: `${prefix}:instructions_adherence`, judge: "instructions_adherence", nodeIndex,
        requestKey, questionKeys: Object.keys(questions),
      }]);
    }
    // Intent gets the LLM intent judge's view: the catalog, the selection and
    // the conversation. The node prompt and variable rules hid a premature
    // intent (0.14 with them, 0.30 without) and kept clean calls uncertain.
    if (judgeAllowed(opts.judges, "intent_identification")) {
      const intents = intentQuestions(node);
      if (intents.length > 0) {
        const requestKey = `i${nodeIndex}`;
        const intentState = Object.fromEntries(INTENT_STATE_KEYS.filter((k) => k in state).map((k) => [k, state[k]]));
        const questions: Record<string, JevNoul> = {};
        const refs: JevIntentQuestionRef[] = [];
        for (const { key, question, intent } of intents) {
          const full = `${requestKey}.${key}`;
          questions[full] = question;
          refs.push({ key: full, intent });
        }
        const tools = Object.values(node.intent_tools ?? {});
        const fired = !!node.chosen_intent || tools.some((t) => String(intentState.node_transcript ?? "").includes(`Tool_Call: ${t}(`));
        addRequest(requestKey, intentState, questions, [{
          kind: "node", id: `${prefix}:intent_identification`, judge: "intent_identification", nodeIndex,
          requestKey, questionKeys: refs.map((r) => r.key), intents: refs,
          ...(fired ? { intentFired: true } : {}),
        }]);
      }
    }
    addRequest(prefix, state, nodeQuestions, nodeAxes);

    if (judgeAllowed(opts.judges, "variable_extraction")) {
      const vars = variableQuestions(node);
      if (vars.length > 0) {
        // Logical chunks retain complete-coverage reduction even when their
        // questions fit alongside the node questions in a shared request.
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
      const { state: hState, agentLines } = buildHallucinationState(groundingContext, node, groundingTranscript, budget - longestHallucinationQuestion, targetTranscript);
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
        addRequest(`h${nodeIndex}`, { ...hState, target_node_uuid: node.node_uuid, evidence_version: evidence.version }, questions, [{
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
          { metric_name: spec.display_name, ...jevNodeState(node, ctx, evidence) },
          { [applicableKey]: applicable, [failKey]: fail },
          [{ kind: "custom", id: requestKey, judge: spec.name, scope: "node", nodeIndex, requestKey, questionKeys: [applicableKey, failKey], applicableKey, failKey }],
        );
      });
    }
  }

  return { requests, axes, dropped };
}
