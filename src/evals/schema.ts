import { z } from "zod";

// ── Event schemas (match LiveKit RunResult shapes, snake_case) ───────────────

const chatMessageEventSchema = z.object({
  type: z.literal("message"),
  role: z.enum(["user", "assistant", "system", "developer"]).optional(),
  content: z.string().optional(),
  interrupted: z.boolean().optional(),
}).passthrough();

const functionCallEventSchema = z.object({
  type: z.literal("function_call"),
  name: z.string().optional(),
  arguments: z.unknown().optional(),
  call_id: z.string().optional(),
}).passthrough();

const functionCallOutputEventSchema = z.object({
  type: z.literal("function_call_output"),
  output: z.string().optional(),
  is_error: z.boolean().optional(),
  call_id: z.string().optional(),
}).passthrough();

const agentHandoffEventSchema = z.object({
  type: z.literal("agent_handoff"),
  from_agent: z.string().optional(),
  to_agent: z.string().optional(),
}).passthrough();

export const runEventSchema = z.discriminatedUnion("type", [
  chatMessageEventSchema,
  functionCallEventSchema,
  functionCallOutputEventSchema,
  agentHandoffEventSchema,
]);

export type RunEvent = z.infer<typeof runEventSchema>;

// ── Judgment ────────────────────────────────────────────────────────────────

export const judgmentResultSchema = z.object({
  intent: z.string(),
  verdict: z.enum(["pass", "fail", "maybe"]),
  reasoning: z.string().optional().default(""),
});
export type JudgmentResult = z.infer<typeof judgmentResultSchema>;

// ── Failure ─────────────────────────────────────────────────────────────────

export const failureSchema = z.object({
  kind: z.enum(["assertion", "error", "timeout", "judge_failed"]),
  message: z.string().optional().default(""),
  stack: z.string().optional(),
  expected_event_index: z.number().int().nonnegative().optional(),
});
export type Failure = z.infer<typeof failureSchema>;

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
  events: z.array(runEventSchema).default([]),
  judgments: z.array(judgmentResultSchema).default([]),
  failure: failureSchema.nullable().optional(),
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
