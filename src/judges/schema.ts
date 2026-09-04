import { z } from "zod";

// A custom judge is deliberately just a name and a plain-language pass/fail
// description plus its scope — the whole point of the feature is that this is
// all a user has to write.
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
