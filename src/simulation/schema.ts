import { z } from "zod";

// A single rubric criterion: a yes/no check with the judge `question` prompt
// and an optional `weight` (default 1) used only by Simulate's score synthesis.
// Accepts a plain string and normalizes it to { name, question: "" }.
export const criterionSchema = z.preprocess(
  (v) => (typeof v === "string" ? { name: v, question: "" } : v),
  z.object({ name: z.string(), question: z.string().default(""), weight: z.coerce.number().optional() }),
);
export type Criterion = z.infer<typeof criterionSchema>;

// A persona supplied inline (e.g. AI-generated ones approved by the user).
const personaInputSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    type: z.string().optional(),
    goal: z.string().optional(),
    opener: z.string().optional(),
    avatar: z.string().optional(),
    voice: z.string().optional(),
    builtin: z.boolean().optional(),
    generated: z.boolean().optional(),
  })
  .passthrough();

// Request to run a simulation. Either a raw `prompt` or `yaml` must be given.
export const simRequestSchema = z
  .object({
    prompt: z.string().optional(),
    yaml: z.string().optional(),
    mode: z.enum(["text", "voice", "text_then_voice"]).default("text"),
    personaIds: z.array(z.string()).default([]),
    personas: z.array(personaInputSchema).default([]),
    rubric: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
        criteria: z.array(criterionSchema).optional(),
        pass_threshold: z.coerce.number().int().min(0).max(100).optional(),
      })
      .optional(),
    autoGen: z.boolean().default(false),
    threshold: z.coerce.number().int().min(0).max(100).default(70),
  })
  .refine((v) => (v.prompt && v.prompt.trim().length > 0) || (v.yaml && v.yaml.trim().length > 0), {
    message: "Provide a non-empty `prompt` or `yaml`.",
  });

export type SimRequest = z.infer<typeof simRequestSchema>;

// Request to generate personas from a prompt (preview-then-approve).
export const generateRequestSchema = z.object({
  prompt: z.string().min(1, "prompt is required"),
  count: z.coerce.number().int().min(1).max(8).default(3),
  types: z.array(z.string()).default(["red_team", "edge_case"]),
});
export type GenerateRequest = z.infer<typeof generateRequestSchema>;
