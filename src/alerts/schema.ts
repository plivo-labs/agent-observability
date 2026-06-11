import { z } from "zod";

// ── Alert rule validation ───────────────────────────────────────────────────
//
// Every rule is a windowed metric threshold, evaluated each sweep over the
// trailing window. It fires when the measured metric EXCEEDS threshold_value:
//   rates (0..1):  eval_fail_rate, outcome_fail_rate, interruption_rate
//   latency (ms):  latency_perceived_p95, latency_llm_ttft_p95,
//                  latency_tts_ttfb_p95, latency_stt_p95

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
  .max(2048)
  .url()
  .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
    message: "webhook_url must be http or https",
  });

const baseRuleShape = {
  name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  account_id: z.string().min(1).max(512).nullable().optional(),
  agent_id: z.string().min(1).max(512).nullable().optional(),
  metric: alertMetricSchema,
  judge_name: z.string().min(1).max(512).nullable().optional(),
  threshold_value: z.number().gt(0),
  // Gates the rule — fire only once the window holds this many samples,
  // so one bad observation can't trip a rate or percentile.
  min_samples: z.number().int().min(1).default(1),
  window_minutes: z.number().int().min(15),
  webhook_url: webhookUrlSchema,
  http_method: httpMethodSchema.default("POST"),
  secret: z.string().min(1).max(1024).nullable().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
};

function checkRule(
  data: { metric?: AlertMetric; judge_name?: string | null; threshold_value?: number },
  ctx: z.RefinementCtx,
) {
  if (data.metric == null) return; // PATCH that doesn't touch the metric
  if (
    data.threshold_value != null &&
    RATE_METRICS.has(data.metric) &&
    data.threshold_value > 1
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["threshold_value"],
      message: "rate thresholds are fractions — use 0.3 for 30%",
    });
  }
  if (data.judge_name != null && !JUDGE_METRICS.has(data.metric)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["judge_name"],
      message: `judge_name does not apply to the ${data.metric} metric`,
    });
  }
}

export const alertRuleCreateSchema = z.object(baseRuleShape).superRefine(checkRule);
export type AlertRuleCreate = z.infer<typeof alertRuleCreateSchema>;

// PATCH accepts any subset; the unit/judge refinements re-run whenever the
// patch carries a metric (the route also re-validates the merged rule).
export const alertRulePatchSchema = z.object(baseRuleShape).partial().superRefine(checkRule);
export type AlertRulePatch = z.infer<typeof alertRulePatchSchema>;
