import { z } from "zod";

// ── Observability-only validation philosophy ────────────────────────────────
//
// Event/judgment/failure bodies are developer inspection data. The server
// stores them as JSONB and the dashboard introspects each entry at render
// time — there's no server-side business logic that reads specific fields.
// Validating them strictly would drop whole payloads the moment a new
// LiveKit event kind ships, and it protects nothing downstream.
//
// So these shapes are `z.unknown()` / passthrough: store whatever the plugin
// sent. The fields the server actually depends on (`run_id`, `case_id`,
// `status`, timestamps — PKs + tally inputs) stay strictly typed below.

// ── Case ────────────────────────────────────────────────────────────────────

export const caseStatusSchema = z.enum(["passed", "failed", "errored", "skipped"]);
export type CaseStatus = z.infer<typeof caseStatusSchema>;

export const evalCaseSchema = z.object({
  case_id: z.string().uuid(),
  name: z.string().min(1),
  file: z.string().nullable().optional(),
  status: caseStatusSchema,
  started_at: z.number().nullable().optional(),
  finished_at: z.number().nullable().optional(),
  duration_ms: z.number().int().nonnegative().nullable().optional(),
  user_input: z.string().nullable().optional(),
  // Inspection data — stored as-is, rendered by the UI per event.
  events: z.array(z.unknown()).default([]),
  judgments: z.array(z.unknown()).default([]),
  failure: z.unknown().nullable().optional(),
});
export type EvalCase = z.infer<typeof evalCaseSchema>;

// ── CI metadata ─────────────────────────────────────────────────────────────

export const ciMetadataSchema = z.object({
  provider: z.string().optional(),
  run_url: z.string().optional(),
  git_sha: z.string().optional(),
  git_branch: z.string().optional(),
  commit_message: z.string().optional(),
}).passthrough();
export type CiMetadata = z.infer<typeof ciMetadataSchema>;

// ── Run ─────────────────────────────────────────────────────────────────────

export const evalRunSchema = z.object({
  run_id: z.string().uuid(),
  account_id: z.string().nullable().optional(),
  agent_id: z.string().nullable().optional(),
  framework: z.string().min(1),           // 'pytest' | 'vitest' | other
  framework_version: z.string().nullable().optional(),
  sdk: z.string().nullable().optional(),
  sdk_version: z.string().nullable().optional(),
  started_at: z.number(),                 // unix seconds
  finished_at: z.number(),
  ci: ciMetadataSchema.nullable().optional(),
});
export type EvalRun = z.infer<typeof evalRunSchema>;

// ── Top-level payload (v0) ──────────────────────────────────────────────────

export const evalPayloadV0Schema = z.object({
  version: z.literal("v0"),
  run: evalRunSchema,
  cases: z.array(evalCaseSchema),
});
export type EvalPayloadV0 = z.infer<typeof evalPayloadV0Schema>;
