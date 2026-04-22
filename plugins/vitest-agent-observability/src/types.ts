// Payload types matching agent-observability's EvalPayloadV0.
// Kept free of server imports so the plugin can evolve independently.

export interface RunEventMessage {
  type: "message";
  role?: string;
  content?: string;
  interrupted?: boolean;
}

export interface RunEventFunctionCall {
  type: "function_call";
  name?: string;
  arguments?: unknown;
  call_id?: string;
}

export interface RunEventFunctionCallOutput {
  type: "function_call_output";
  output?: string;
  is_error?: boolean;
  call_id?: string;
}

export interface RunEventAgentHandoff {
  type: "agent_handoff";
  from_agent?: string;
  to_agent?: string;
}

export type RunEvent =
  | RunEventMessage
  | RunEventFunctionCall
  | RunEventFunctionCallOutput
  | RunEventAgentHandoff;

export interface JudgmentResult {
  intent: string;
  verdict: "pass" | "fail" | "maybe";
  reasoning: string;
}

export interface Failure {
  kind: "assertion" | "error" | "timeout" | "judge_failed";
  message?: string;
  stack?: string;
  expected_event_index?: number;
}

export type CaseStatus = "passed" | "failed" | "errored" | "skipped";

export interface EvalCase {
  case_id: string;
  name: string;
  file?: string;
  status: CaseStatus;
  started_at?: number;
  finished_at?: number;
  duration_ms?: number;
  user_input?: string;
  events: RunEvent[];
  judgments: JudgmentResult[];
  failure?: Failure | null;
}

export interface CiMetadata {
  provider?: string;
  run_url?: string;
  git_sha?: string;
  git_branch?: string;
  commit_message?: string;
  [k: string]: unknown;
}

export interface EvalRun {
  run_id: string;
  account_id?: string | null;
  agent_id?: string | null;
  framework: string;
  framework_version?: string;
  sdk?: string;
  sdk_version?: string;
  started_at: number;
  finished_at: number;
  ci?: CiMetadata | null;
}

export interface EvalPayloadV0 {
  version: "v0";
  run: EvalRun;
  cases: EvalCase[];
}

export interface ReporterOptions {
  url?: string;
  agentId?: string | null;
  accountId?: string | null;
  basicAuth?: { user: string; pass: string } | null;
  timeoutMs?: number;
  maxRetries?: number;
  fallbackDir?: string | null;
}
