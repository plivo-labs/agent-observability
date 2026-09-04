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
