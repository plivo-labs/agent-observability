import { z } from "zod";

// ── Alert rule validation ───────────────────────────────────────────────────
//
// Windowed-threshold rules over post-conversation signals. Three trigger
// types; the threshold field required depends on the type, enforced via
// superRefine below:
//   evaluation_count → threshold_count       (≥ N matching verdicts)
//   outcome_count    → threshold_count       (≥ N matching outcomes)
//   pass_rate        → threshold_pass_rate   (rate < threshold; min_samples gate)

export const triggerTypeSchema = z.enum(["evaluation_count", "outcome_count", "pass_rate"]);
export type TriggerType = z.infer<typeof triggerTypeSchema>;

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
  judge_name: z.string().min(1).nullable().optional(),
  verdicts: verdictsSchema.default(["fail"]),
  threshold_count: z.number().int().min(1).nullable().optional(),
  threshold_pass_rate: z.number().gt(0).max(1).nullable().optional(),
  min_samples: z.number().int().min(1).default(1),
  window_minutes: z.number().int().min(15),
  webhook_url: webhookUrlSchema,
  http_method: httpMethodSchema.default("POST"),
  secret: z.string().min(1).nullable().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
};

function checkThresholds(
  data: { trigger_type?: TriggerType; threshold_count?: number | null; threshold_pass_rate?: number | null },
  ctx: z.RefinementCtx,
) {
  if (data.trigger_type == null) return; // PATCH without type change
  if (data.trigger_type === "pass_rate") {
    if (data.threshold_pass_rate == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["threshold_pass_rate"],
        message: "threshold_pass_rate is required for pass_rate rules",
      });
    }
  } else if (data.threshold_count == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["threshold_count"],
      message: "threshold_count is required for count rules",
    });
  }
}

export const alertRuleCreateSchema = z.object(baseRuleShape).superRefine(checkThresholds);
export type AlertRuleCreate = z.infer<typeof alertRuleCreateSchema>;

// PATCH accepts any subset; thresholds re-checked only when trigger_type
// is part of the patch (a type change must bring its threshold along).
export const alertRulePatchSchema = z.object(baseRuleShape).partial().superRefine(checkThresholds);
export type AlertRulePatch = z.infer<typeof alertRulePatchSchema>;
