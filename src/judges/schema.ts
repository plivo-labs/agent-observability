import { z } from "zod";

// A custom judge is deliberately just a name and a plain-language pass/fail
// description plus its scope — the whole point of the feature is that this is
// all a user has to write.
//
// TRUST MODEL: the description becomes part of an LLM SYSTEM prompt (that is
// the feature — it IS the judge's criteria). The API assumes the same trusted
// intermediary caller as the rest of the dashboard API; the transcript stays
// fenced as untrusted data AFTER it (run-llm-judge appends the fence), so a
// hostile description can only degrade its own judge's verdicts. Revisit
// before ever exposing this endpoint to less-trusted callers than the
// account's own builder.
export const judgeCreateSchema = z.object({
  display_name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(4000),
  scope: z.enum(["node", "conversation"]),
  enabled: z.boolean().optional().default(false),
});

export const judgePatchSchema = z
  .object({
    display_name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(4000).optional(),
    scope: z.enum(["node", "conversation"]).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "empty patch" });

export const agentJudgesPutSchema = z.object({
  judges: z
    .array(
      z.object({
        judge_id: z.string().uuid(),
        enabled: z.boolean().optional(),
      }),
    )
    .max(200),
});

export const judgeTestSchema = z.object({
  session_ids: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
});

// ── AI authoring (generate / improve / calibrate) ────────────────────────────
const metricScope = z.enum(["node", "conversation"]);

export const metricImproveSchema = z.object({
  name: z.string().trim().max(120).optional().default(""),
  description: z.string().trim().min(1).max(4000),
  scope: metricScope.optional().default("conversation"),
});

// The console sends the real flow config verbatim; AO forwards the whole JSON
// to the prompt and makes no assumptions about its shape, so `flow` is an
// open object (passthrough) rather than a fixed schema. `name`/`nodes`/`edges`
// are read best-effort for the human-readable lead-in when present.
export const metricGenerateSchema = z.object({
  flow: z.record(z.string(), z.unknown()),
  existing: z
    .array(z.object({ name: z.string().optional(), description: z.string().optional() }))
    .optional()
    .default([]),
  max_new: z.number().int().min(1).max(10).optional(),
});

export const metricCalibrateSchema = z.object({
  name: z.string().trim().max(120).optional().default(""),
  description: z.string().trim().min(1).max(4000),
  scope: metricScope.optional().default("conversation"),
  examples: z
    .array(
      z.object({
        session_id: z.string().trim().min(1).max(200),
        desired_verdict: z.enum(["pass", "fail"]),
        reason: z.string().trim().max(2000).optional(),
      }),
    )
    .min(1)
    .max(10),
});
