import { z } from "zod";

// ── Alert rule validation ───────────────────────────────────────────────────
//
// Windowed rules, evaluated every sweep over the trailing window:
//   evaluation_count  → ≥ threshold_count matching judge verdicts
//   outcome_count     → ≥ threshold_count matching session outcomes
//   metric_threshold  → a measured metric crosses threshold_value:
//     rates (0..1):  eval_fail_rate, outcome_fail_rate, interruption_rate
//     latency (ms):  latency_perceived_p95, latency_llm_ttft_p95,
//                    latency_tts_ttfb_p95, latency_stt_p95
//   Every metric fires when the value EXCEEDS the threshold.

export const triggerTypeSchema = z.enum(["evaluation_count", "outcome_count", "metric_threshold"]);
export type TriggerType = z.infer<typeof triggerTypeSchema>;

export const alertMetricSchema = z.enum([
  "eval_fail_rate",
  "outcome_fail_rate",
  "latency_perceived_p95",
  "latency_llm_ttft_p95",
  "latency_tts_ttfb_p95",
  "latency_stt_p95",
  "interruption_rate",
]);
export type AlertMetric = z.infer<typeof alertMetricSchema>;

export const RATE_METRICS: ReadonlySet<AlertMetric> = new Set([
  "eval_fail_rate",
  "outcome_fail_rate",
  "interruption_rate",
]);

/** Metrics where judge_name is a meaningful filter. */
const JUDGE_METRICS: ReadonlySet<AlertMetric> = new Set(["eval_fail_rate"]);

const httpMethodSchema = z.enum(["POST", "PUT", "PATCH"]);

const webhookUrlSchema = z
  .string()
  .url()
  .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
    message: "webhook_url must be http or https",
  });

const verdictsSchema = z
  .array(z.string().min(1))
  .min(1)
  .transform((arr) => arr.map((v) => v.toLowerCase()));

const baseRuleShape = {
  name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  account_id: z.string().min(1).nullable().optional(),
  agent_id: z.string().min(1).nullable().optional(),
  trigger_type: triggerTypeSchema,
  metric: alertMetricSchema.nullable().optional(),
  judge_name: z.string().min(1).nullable().optional(),
  verdicts: verdictsSchema.default(["fail"]),
  threshold_count: z.number().int().min(1).nullable().optional(),
  threshold_value: z.number().gt(0).nullable().optional(),
  // Gates rate and latency metrics — one bad sample can't fire a rule.
  min_samples: z.number().int().min(1).default(1),
  window_minutes: z.number().int().min(15),
  webhook_url: webhookUrlSchema,
  http_method: httpMethodSchema.default("POST"),
  secret: z.string().min(1).nullable().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
};

function checkTriggerShape(
  data: {
    trigger_type?: TriggerType;
    metric?: AlertMetric | null;
    judge_name?: string | null;
    threshold_count?: number | null;
    threshold_value?: number | null;
  },
  ctx: z.RefinementCtx,
) {
  if (data.trigger_type == null) return; // PATCH without type change
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

  if (data.trigger_type === "metric_threshold") {
    if (data.metric == null) issue("metric", "metric is required for metric_threshold rules");
    if (data.threshold_value == null) {
      issue("threshold_value", "threshold_value is required for metric_threshold rules");
    } else if (data.metric != null && RATE_METRICS.has(data.metric) && data.threshold_value > 1) {
      issue("threshold_value", "rate thresholds are fractions — use 0.3 for 30%");
    }
    if (data.judge_name != null && data.metric != null && !JUDGE_METRICS.has(data.metric)) {
      issue("judge_name", `judge_name does not apply to the ${data.metric} metric`);
    }
  } else {
    if (data.threshold_count == null) {
      issue("threshold_count", "threshold_count is required for count rules");
    }
    if (data.metric != null) issue("metric", "metric only applies to metric_threshold rules");
    // Outcomes have no judge — reject rather than silently ignoring the filter.
    if (data.trigger_type === "outcome_count" && data.judge_name != null) {
      issue("judge_name", "judge_name does not apply to outcome_count rules");
    }
  }
}

export const alertRuleCreateSchema = z.object(baseRuleShape).superRefine(checkTriggerShape);
export type AlertRuleCreate = z.infer<typeof alertRuleCreateSchema>;

// PATCH accepts any subset; trigger shape is re-checked only when
// trigger_type is part of the patch (a type change must bring its
// threshold/metric along).
export const alertRulePatchSchema = z.object(baseRuleShape).partial().superRefine(checkTriggerShape);
export type AlertRulePatch = z.infer<typeof alertRulePatchSchema>;
