import { z } from "zod";
import type { LlmProvider, LlmUsage } from "../../llm/index.js";
import type { ConversationInput, NodeEvalInput } from "../types.js";
import { runLlmJudge } from "./run-llm-judge.js";

// One batched LLM call that writes the reasons for every verdict Jev published.
// It never re-judges: that would bring back the per-axis calls the gate avoids.
// The transcript is sent once with per-node config listed separately, so the
// call does not grow a transcript per failing node.

export interface ReasonRequestAxis {
  /** The gated axis id; echoed back so the caller can map the text home. */
  id: string;
  judge: string;
  node_name?: string;
  /** What fired, in the judge's own terms (variable names, intent names). */
  detail?: string;
  /** Every item is labelled: telling the model a defect is present when it is
   *  not invites invented evidence. */
  kind?: "defect" | "clean" | "not_applicable";
}

export interface ReasonWriterInput {
  ctx: ConversationInput;
  nodes: Array<{ node: NodeEvalInput; nodeIndex: number }>;
  axes: ReasonRequestAxis[];
  provider?: LlmProvider;
}

const ReasonZ = z.object({
  reasons: z.array(
    z.object({
      id: z.string(),
      reason: z.string().default(""),
      technical_reason: z.string().default(""),
    }),
  ).default([]),
});

// A strict JSON schema cannot carry dynamic keys, so axes come back as an array
// keyed by id.
const REASON_JSON = {
  name: "eval_jev_reason",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["reasons"],
    properties: {
      reasons: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "reason", "technical_reason"],
          properties: { id: { type: "string" }, reason: { type: "string" }, technical_reason: { type: "string" } },
        },
      },
    },
  },
} as const;

export const REASON_WRITER_SYSTEM =
  "A calibrated classifier has ALREADY decided every entry in `items` for this conversation. " +
  "Your job is only to EXPLAIN each one, never to re-judge it: do not dispute, soften, or overturn any verdict, and do not add entries. " +
  "Each entry carries a `kind`. For `kind: \"defect\"` the classifier found that defect present — explain what went wrong, quoting the deciding " +
  "evidence from the transcript. For `kind: \"clean\"` the classifier found NO defect — explain briefly what the agent did that satisfies this check, " +
  "citing the transcript; do not invent a problem. For `kind: \"not_applicable\"` the classifier found that the metric's situation never arose on this call — explain " +
  "WHICH situation the metric expected and what the call did instead; do not describe it as a failure and do not invent a defect. " +
  "For every entry return an object with the SAME `id`, a `reason` (one or two sentences for the person reading the call review) and a " +
  "`technical_reason` (the internal rationale, naming the instruction, variable, intent, metric or transcript line involved). " +
  "If the transcript does not show why an entry was decided the way it was, say so plainly in `reason` rather than inventing evidence. " +
  "Return one entry per item and nothing else.";

// Scaled by item count: a fixed limit truncates the JSON on large sessions,
// and every truncated attempt is paid for before the templated fallback.
const REASON_MIN_TOKENS = 4000;
const REASON_TOKENS_PER_ITEM = 150;
const REASON_MAX_TOKENS = 16000;

export interface ReasonWriterResult {
  reasons: Map<string, { reason: string; technical_reason: string }>;
  usage: LlmUsage;
}

export async function writeDecisionReasons(input: ReasonWriterInput): Promise<ReasonWriterResult> {
  const { ctx, nodes, axes, provider } = input;
  const { data, usage } = await runLlmJudge({
    system: REASON_WRITER_SYSTEM,
    input: {
      flow_name: ctx.flow_name,
      global_prompt: ctx.global_prompt,
      conversation_history: ctx.full_transcript,
      nodes: nodes.map(({ node, nodeIndex }) => ({
        node_index: nodeIndex,
        node_name: node.node_name,
        node_prompt: node.node_prompt,
        available_intents: node.available_intents,
        chosen_intent: node.chosen_intent,
        required_variables: node.required_variables,
        ...(node.variable_rules ? { variable_rules: node.variable_rules } : {}),
        extracted_variables: node.extracted_variables,
      })),
      items: axes,
    },
    schema: ReasonZ,
    jsonSchema: REASON_JSON,
    maxTokens: Math.min(REASON_MAX_TOKENS, Math.max(REASON_MIN_TOKENS, axes.length * REASON_TOKENS_PER_ITEM)),
    provider,
  });
  const asked = new Set(axes.map((a) => a.id));
  const reasons = new Map<string, { reason: string; technical_reason: string }>();
  for (const entry of data.reasons) {
    // Unasked ids are dropped; the caller templates a missing id rather than
    // mis-attributing text.
    if (asked.has(entry.id) && (entry.reason.trim() || entry.technical_reason.trim())) {
      reasons.set(entry.id, { reason: entry.reason.trim(), technical_reason: entry.technical_reason.trim() });
    }
  }
  return { reasons, usage };
}
