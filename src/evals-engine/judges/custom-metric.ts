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
import type { ConversationInput, NodeEvalInput } from "../types.js";
import { runLlmJudge } from "./run-llm-judge.js";
import { renderNodeTranscript } from "./node-judge-payload.js";
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

export type CustomMetricNodeVerdict = {
  ref: string;
  node_name: string;
  verdict: "pass" | "fail" | "unknown";
  reason: string;
  technical_reason: string;
};

export type CustomMetricVerdict = {
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
};

const CustomMetricRawZ = z.object({
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
      verdict: { type: "string", enum: ["pass", "fail", "unknown"] },
      reason: { type: "string" },
      technical_reason: { type: "string" },
    },
    required: ["verdict", "reason", "technical_reason"],
    additionalProperties: false,
  },
  strict: true,
} as const;

const DEFAULT_CUSTOM_MAX_TOKENS = 1200;

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
): Promise<z.infer<typeof CustomMetricRawZ>> {
  const { data } = await runLlmJudge({
    system: spec.body + spec.output,
    input,
    schema: CustomMetricRawZ,
    jsonSchema: CUSTOM_METRIC_JSON,
    maxTokens: spec.max_tokens ?? DEFAULT_CUSTOM_MAX_TOKENS,
    provider,
  });
  return data;
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
async function runCustomMetricJudge(
  spec: CustomJudgeSpec,
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<CustomMetricVerdict> {
  try {
    if (spec.scope === "conversation") {
      const data = await judgeOnce(
        spec,
        {
          metric_name: spec.display_name,
          flow_name: ctx.flow_name,
          conversation_history: ctx.speech_transcript || ctx.full_transcript,
        },
        provider,
      );
      return { judge_name: spec.name, display_name: spec.display_name, scope: spec.scope, ...data, available: true };
    }
    // node scope: judge each judged node independently, roll up for the summary
    const per_node = await Promise.all(
      ctx.nodes.map(async (node: NodeEvalInput): Promise<CustomMetricNodeVerdict> => {
        const data = await judgeOnce(
          spec,
          {
            metric_name: spec.display_name,
            flow_name: ctx.flow_name,
            node_name: node.node_name,
            node_prompt: node.node_prompt,
            node_transcript: renderNodeTranscript(node),
            conversation_history: ctx.full_transcript,
          },
          provider,
        );
        return { ref: node.node_uuid, node_name: node.node_name, ...data };
      }),
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
  provider?: LlmProvider,
): Promise<CustomMetricVerdict[]> {
  return Promise.all(specs.map((s) => runCustomMetricJudge(s, ctx, provider)));
}
