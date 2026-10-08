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
  unmet_required_criteria: z.array(z.string()).default([]),
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
      technical_reason: {
        type: "string",
        description: "First identify the evidence that makes this metric applicable, before evaluating success. For a response to a conditional event (such as a problem needing human follow-up), cite the actual event or need: screening for it is not its occurrence, and an issue resolved in this call does not establish a need for later escalation. For a task-completion metric, cite a substantive caller response or an actual task action: merely asking whether it is done or offering help, followed only by hello/connectivity checks, is unreached. Explicit failure rules and obligations at the opening still apply. Then explain the outcome against only the metric's actual requirements.",
      },
      situation_reached: {
        type: "boolean",
        description: "Did the metric's triggering event or opportunity actually occur? Establish this independently of whether the required action succeeded. An opening/contact attempt or an unanswered offer to begin a later task does not reach that task. False if the call ended before the relevant trigger or opportunity. True if that trigger occurred but the required agent action was omitted, or the metric explicitly treats the observed early termination as failure.",
      },
      unmet_required_criteria: {
        type: "array",
        items: { type: "string" },
        description: "List each required success condition the transcript establishes was not met. Do not invent requirements. A courteous wrap-up or offer of future support after the substantive stages counts as polite closure even if interrupted. A direct yes/okay/got-it response to information is an acknowledgement of it; the caller need not repeat the information unless the metric expressly requires a readback. Empty when none are unmet; genuinely insufficient evidence should produce unknown, not pass.",
      },
      verdict: { type: "string", enum: ["pass", "fail", "unknown"] },
      reason: { type: "string" },
    },
    required: ["technical_reason", "situation_reached", "unmet_required_criteria", "verdict", "reason"],
    additionalProperties: false,
  },
  strict: true,
} as const;

const DEFAULT_CUSTOM_MAX_TOKENS = 1200;

// Appended in code because each metric's prompt is stored at creation.
const APPLICABILITY = `

APPLICABILITY BEFORE SUCCESS:
Return the structured schema fields, including technical_reason, situation_reached and unmet_required_criteria. Write technical_reason first: identify the observed applicability evidence before deciding whether required success conditions were met. This extends the output fields above.
1. Identify the metric's triggering event or relevant opportunity separately from its success condition. Cite the observed trigger in technical_reason. The fact that an action is required does not prove there was an opportunity to perform it. For a metric about responding to a conditional event or need, the trigger is that event or need, not the opportunity to ask about it. Screening questions, a caller denying concerns, or an issue resolved during the call do not establish an outstanding need for human follow-up.
2. An agent introduction or identity question alone does not establish a live caller or reach later information-collection, setup, or support stages. If the transcript ends at the opening with no caller response, metrics requiring later customer information or acknowledgement have situation_reached=false and verdict=unknown. The same boundary applies later in a live call: merely raising a topic, asking whether a task is already done, or offering to help does not establish engagement in that task. If the call cuts off before a substantive response or any task action, that task's completion metric is unreached. A connectivity check such as "hello?" is not a substantive task response. The absent success evidence is not a failure when that stage was never reached.
3. Once the trigger or opportunity actually occurred, a missing required action or unsuccessful outcome is NOT an unreached situation. For example, a caller requested assistance but the agent omitted the required handoff: situation_reached=true, verdict=fail. Do not excuse a skipped obligation on a reached path by calling its missing action the trigger.
4. The metric's own explicit failure conditions still apply, including immediate disconnection when it expressly names that as failure. A rule about the opening itself can also be judged from the opening. These have situation_reached=true even without a caller response. A generic metric about handling closure or technical cases is NOT an instruction to fail every truncated transcript: an interrupted opening alone establishes neither a closure event nor a technical problem. Do not infer an agent-caused abrupt ending solely because the transcript stops. A "never do X" metric can pass when X never occurred.
5. Only after establishing applicability, assess success. For triggered or task-completion metrics, if the situation was unreached, return unknown with an empty unmet_required_criteria list. Preserve pass for an unconditional prohibition when the prohibited action never occurred. A pass requires evidence for ALL success conditions the metric requires. Check them individually and list unmet_required_criteria before choosing a verdict. Repeated progress through one unfinished task does not establish completion of the majority of stages. A call still in core setup with no wrap-up is not a completed welcome call. A courteous wrap-up or offer of future support AFTER the substantive stages counts as polite closure even if interrupted; no separate goodbye or fully spoken support number is required unless the metric expressly requires it. An interrupted courteous wrap-up is not an agent-caused abrupt ending. This does not excuse an unfinished core task or an explicitly required customer acknowledgement.
6. Interpret acknowledgement in conversational context: a direct "yes", "okay", "got it", or equivalent in the caller's language after support instructions acknowledges those instructions. The caller need not repeat a phone number or say "I know where to contact" unless the metric explicitly requires a readback or those exact words. An unrelated earlier backchannel is not acknowledgement of information given later; an explicit denial of understanding is contrary evidence. If the metric explicitly defines a failure seen in the transcript, return fail. Use unknown for genuinely insufficient evidence.`;

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
): Promise<Omit<z.infer<typeof CustomMetricRawZ>, "situation_reached" | "unmet_required_criteria">> {
  const { data } = await runLlmJudge({
    system: spec.body + spec.output + APPLICABILITY,
    input,
    schema: CustomMetricRawZ,
    jsonSchema: CUSTOM_METRIC_JSON,
    maxTokens: spec.max_tokens ?? DEFAULT_CUSTOM_MAX_TOKENS,
    provider,
  });
  const { situation_reached, unmet_required_criteria, ...verdict } = data;
  // Partial success cannot override a requirement the judge itself found unmet.
  // Preserve unknown when evidence is insufficient and applicability when the
  // opportunity never arose. A prohibition with no violation still passes.
  if (verdict.verdict === "pass" && unmet_required_criteria.some(criterion => criterion.trim())) {
    return {
      verdict: situation_reached ? "fail" : "unknown",
      reason: situation_reached
        ? `Required metric criteria were not met: ${unmet_required_criteria.join("; ")}`
        : "The call never reached the situation this metric is about.",
      technical_reason: `${verdict.technical_reason} Contradictory pass corrected from applicability and unmet required criteria.`,
    };
  }
  // Only a fail is demoted: a "never do X" metric can pass without its event.
  return situation_reached || verdict.verdict !== "fail" ? verdict : {
    verdict: "unknown",
    reason: "The call never reached the situation this metric is about.",
    technical_reason: `situation not reached; the judge's fail was: ${verdict.reason}`,
  };
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
