// The prompt contract for CUSTOM judges (registry rows named metric:<slug>).
// A custom judge is a name + a plain-language pass/fail description; the
// system prompt is that description composed with this fixed output section —
// the same body/output split the default judges use, so the registry stores
// both kinds identically.

export const CUSTOM_METRIC_OUT = `

Judge ONLY what the metric description above asks about — everything else is out of scope. Base the verdict strictly on the transcript evidence; never assume unstated facts. "unknown" is the honest verdict when the call never reached the situation the metric describes, or the evidence is insufficient to decide.

Return ONLY a JSON object: {"verdict": "pass"|"fail"|"unknown", "reason": string, "technical_reason": string}. \`reason\` is a short human explanation quoting the deciding evidence; \`technical_reason\` is the internal rationale.`;

/** Slug for a custom judge's registry name: metric:<slug-of-display-name>. */
export function customJudgeName(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `metric:${slug}`;
}

export const CUSTOM_JUDGE_NAME_RE = /^metric:[a-z0-9_]+$/;

// ── execution ────────────────────────────────────────────────────────────────
import { z } from "zod";
import type { LlmProvider } from "../../llm/index.js";
import type { ConversationInput, JudgeProvenance, NodeEvalInput } from "../types.js";
import { runLlmJudge } from "./run-llm-judge.js";
import { nodePayload } from "./node-judge-payload.js";
import { classifyErrorDurability } from "../../error-durability.js";

/** What the sweeper hands the engine per mapped custom judge. */
export interface CustomJudgeSpec {
  name: string; // metric:<slug> — the fan-out judge_name
  display_name: string;
  scope: "node" | "conversation";
  body: string;
  output: string;
  max_tokens?: number;
}

export type CustomMetricNodeVerdict = JudgeProvenance & {
  ref: string;
  node_name: string;
  verdict: "pass" | "fail" | "unknown";
  reason: string;
  technical_reason: string;
};

export type CustomMetricVerdict = JudgeProvenance & {
  judge_name: string;
  display_name: string;
  scope: "node" | "conversation";
  verdict: "pass" | "fail" | "unknown";
  reason: string;
  technical_reason: string;
  /** False when the judge could not run (deterministic failure) — fan-out
   *  skips unavailable verdicts, the same contract as CmDetection. */
  available: boolean;
  per_node?: CustomMetricNodeVerdict[];
  /** Retain collected signals when node review is unavailable, without inventing per-node verdicts. */
  jev_node_candidates?: Array<JudgeProvenance & { ref: string }>;
};

const CustomMetricRawZ = z.object({
  // A provider that ignores the strict schema keeps the pre-field behaviour.
  situation_reached: z.boolean().default(true),
  verdict: z.enum(["pass", "fail", "unknown"]),
  reason: z.string(),
  technical_reason: z.string(),
});

// One shared schema name: it doubles as the LLM accounting label, and a label
// per custom judge would make cost-report cardinality unbounded.
const CUSTOM_METRIC_JSON = {
  name: "eval_custom_metric",
  schema: {
    type: "object",
    properties: {
      situation_reached: {
        type: "boolean",
        description: "Did the specific situation this metric is about actually happen on this call? For a metric about an event (the caller declines, a wrong person answers, voicemail is reached, a callback is requested), false when that event never occurred. Also false when the call never got there: no live person, or cut off first.",
      },
      verdict: { type: "string", enum: ["pass", "fail", "unknown"] },
      reason: { type: "string" },
      technical_reason: { type: "string" },
    },
    required: ["situation_reached", "verdict", "reason", "technical_reason"],
    additionalProperties: false,
  },
  strict: true,
} as const;

const DEFAULT_CUSTOM_MAX_TOKENS = 1200;

// Appended in code because each metric's prompt is stored at creation.
const APPLICABILITY = `

situation_reached: a metric about an event or outcome (the caller declines, a wrong person answers, voicemail is reached) does not apply when that event never happened on this call — answer false, not a fail.`;

const unavailable = (spec: CustomJudgeSpec, why: string): CustomMetricVerdict => ({
  judge_name: spec.name,
  display_name: spec.display_name,
  scope: spec.scope,
  verdict: "unknown",
  reason: "",
  technical_reason: why,
  available: false,
});

async function judgeOnce(
  spec: CustomJudgeSpec,
  input: Record<string, unknown>,
  provider?: LlmProvider,
): Promise<Omit<z.infer<typeof CustomMetricRawZ>, "situation_reached">> {
  const { data } = await runLlmJudge({
    system: spec.body + spec.output + APPLICABILITY,
    input,
    schema: CustomMetricRawZ,
    jsonSchema: CUSTOM_METRIC_JSON,
    maxTokens: spec.max_tokens ?? DEFAULT_CUSTOM_MAX_TOKENS,
    provider,
  });
  // Judges failed unreached situations despite the stored prompt. Only a fail is
  // demoted: a "never do X" metric rightly passes a call where nothing happened.
  const { situation_reached, ...verdict } = data;
  return situation_reached || verdict.verdict !== "fail" ? verdict : { ...verdict, verdict: "unknown" };
}

export async function judgeCustomMetricNode(
  spec: CustomJudgeSpec,
  node: NodeEvalInput,
  ctx: ConversationInput,
  refOf: (nodeUuid: string) => string,
  provider?: LlmProvider,
): Promise<CustomMetricNodeVerdict> {
  const data = await judgeOnce(
    spec,
    {
      metric_name: spec.display_name,
      flow_name: ctx.flow_name,
      // The built-in node judges' payload, so intent- or variable-shaped criteria
      // can be judged, not just the raw transcript.
      ...nodePayload(node, ctx),
    },
    provider,
  );
  // The SENDER's opaque ref, not the engine uuid — consumers map custom
  // per-node rows back to their nodes exactly like the default node rows.
  return { ref: refOf(node.node_uuid), node_name: node.node_name, ...data };
}

/** Roll per-node verdicts up to one metric verdict: any fail fails the call,
 *  any pass (without a fail) passes it, all-unknown stays unknown. */
export function rollUpNodeVerdicts(nodes: CustomMetricNodeVerdict[]): "pass" | "fail" | "unknown" {
  if (nodes.some((n) => n.verdict === "fail")) return "fail";
  if (nodes.some((n) => n.verdict === "pass")) return "pass";
  return "unknown";
}

/** Run one custom judge over the session. Failure posture mirrors the
 *  conversation judges (safeJudge): a DETERMINISTIC failure returns an
 *  unavailable verdict — one broken custom judge must not blank the default
 *  judging — while a TRANSIENT failure (timeout/429/5xx) rethrows so the
 *  whole session retries via stale claim adoption. */
export async function runCustomMetricJudge(
  spec: CustomJudgeSpec,
  ctx: ConversationInput,
  refOf: (nodeUuid: string) => string,
  provider?: LlmProvider,
): Promise<CustomMetricVerdict> {
  try {
    if (spec.scope === "conversation") {
      const data = await judgeOnce(
        spec,
        {
          metric_name: spec.display_name,
          flow_name: ctx.flow_name,
          global_prompt: ctx.global_prompt,
          // FULL transcript, evidence lines included — unlike the counterparty
          // detections (which deliberately judge speech only), a custom metric
          // often judges tool behaviour ("claimed to send the SMS", "booking
          // actually created") and is blind without Tool_Call/Tool_Result.
          conversation_history: ctx.full_transcript,
          ...(ctx.global_variables && Object.keys(ctx.global_variables).length > 0
            ? { global_variables: ctx.global_variables }
            : {}),
        },
        provider,
      );
      return { judge_name: spec.name, display_name: spec.display_name, scope: spec.scope, ...data, available: true };
    }
    // node scope: judge each judged node independently, roll up for the summary
    const per_node = await Promise.all(
      ctx.nodes.map((node: NodeEvalInput) => judgeCustomMetricNode(spec, node, ctx, refOf, provider)),
    );
    const verdict = rollUpNodeVerdicts(per_node);
    const deciding = per_node.find((n) => n.verdict === verdict);
    return {
      judge_name: spec.name,
      display_name: spec.display_name,
      scope: spec.scope,
      verdict,
      reason: deciding?.reason ?? "",
      technical_reason: deciding?.technical_reason ?? "",
      available: true,
      per_node,
    };
  } catch (e) {
    if (classifyErrorDurability(e) === "transient") throw e;
    return unavailable(spec, `custom judge unavailable: ${(e as Error).message ?? e}`);
  }
}

/** All mapped custom judges for the session, in parallel (the global judge
 *  semaphore in runLlmJudge bounds real concurrency). */
export function runCustomMetricJudges(
  specs: readonly CustomJudgeSpec[],
  ctx: ConversationInput,
  refOf: (nodeUuid: string) => string,
  provider?: LlmProvider,
): Promise<CustomMetricVerdict[]> {
  return Promise.all(specs.map((s) => runCustomMetricJudge(s, ctx, refOf, provider)));
}
