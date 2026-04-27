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
//
// Two distinct concepts are surfaced as separate fields:
//   - `framework`           — agent framework (`livekit` | `pipecat` | …)
//   - `testing_framework`   — test framework that ran the suite
//                             (`pytest` | `vitest` | …)
//
// Plugins on or after 0.2.x send the new shape directly. Plugins ≤ 0.1.x
// send a legacy shape where `framework` carried the test framework name
// and `sdk` carried the agent framework. We accept both via a preprocess
// step that normalizes legacy → new before validation: a `framework` of
// `pytest`/`vitest` triggers the legacy interpretation (and `sdk` is
// remapped to `framework`). New-shape input is left untouched.

const AGENT_FRAMEWORK_NORMALIZERS: Record<string, string> = {
  "livekit-agents": "livekit",
  "pipecat-ai": "pipecat",
  "pipecat-ai-flows": "pipecat",
};

function normalizeAgentFramework(name: unknown): unknown {
  if (typeof name !== "string") return name;
  return AGENT_FRAMEWORK_NORMALIZERS[name] ?? name;
}

const TESTING_FRAMEWORKS = new Set(["pytest", "vitest"]);

const evalRunObjectSchema = z.object({
  run_id: z.string().uuid(),
  account_id: z.string().nullable().optional(),
  agent_id: z.string().nullable().optional(),
  // Agent framework family (livekit / pipecat / …). Optional because it
  // may not be detectable in every environment.
  framework: z.string().nullable().optional(),
  framework_version: z.string().nullable().optional(),
  // Test framework name (pytest / vitest / …). Required.
  testing_framework: z.string().min(1),
  testing_framework_version: z.string().nullable().optional(),
  started_at: z.number(),                 // unix seconds
  finished_at: z.number(),
  ci: ciMetadataSchema.nullable().optional(),
});

export const evalRunSchema = z.preprocess((raw) => {
  if (raw == null || typeof raw !== "object") return raw;
  const obj = { ...(raw as Record<string, unknown>) };

  // If both new-style and legacy fields are sent, prefer the new ones —
  // strip the legacy keys so they don't leak into the validated row.
  const hasLegacyTesting =
    typeof obj.framework === "string" &&
    TESTING_FRAMEWORKS.has(obj.framework as string) &&
    obj.testing_framework === undefined;

  if (hasLegacyTesting) {
    obj.testing_framework = obj.framework;
    obj.testing_framework_version = obj.framework_version ?? null;
    obj.framework = obj.sdk ?? null;
    obj.framework_version = obj.sdk_version ?? null;
  }

  // In all cases, normalize a legacy package name to the canonical
  // family value (so `livekit-agents` becomes `livekit`).
  obj.framework = normalizeAgentFramework(obj.framework);

  // Strip the legacy slots from the validated shape.
  delete obj.sdk;
  delete obj.sdk_version;

  return obj;
}, evalRunObjectSchema);
export type EvalRun = z.infer<typeof evalRunSchema>;

// ── Top-level payload (v0) ──────────────────────────────────────────────────

export const evalPayloadV0Schema = z.object({
  version: z.literal("v0"),
  run: evalRunSchema,
  cases: z.array(evalCaseSchema),
});
export type EvalPayloadV0 = z.infer<typeof evalPayloadV0Schema>;
