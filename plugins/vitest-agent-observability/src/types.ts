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
  /** Optional freeform label for the run, set by the user via
   *  `runName` reporter option or `AGENT_OBSERVABILITY_RUN_NAME`.
   *  Surfaced in the dashboard to disambiguate same-agent runs. */
  name?: string | null;
  account_id?: string | null;
  agent_id?: string | null;
  /** Agent framework family — `livekit` / `pipecat` / …. Null when no
   *  known agent-framework package is installed. */
  framework: string | null;
  /** Version of the detected agent-framework package. */
  framework_version: string | null;
  /** Test framework that ran the suite — `vitest`. */
  testing_framework: string;
  /** Version of the test framework. */
  testing_framework_version: string | null;
  started_at: number;
  /** Null when the run is still in progress. */
  finished_at: number | null;
  /** Run lifecycle state. Server treats null finished_at as "running". */
  status?: "queued" | "running" | "completed" | "failed" | "cancelled" | null;
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
  /** Optional freeform label for this run (e.g. "v9.1-with-new-prompt").
   *  Falls back to `AGENT_OBSERVABILITY_RUN_NAME`. */
  runName?: string | null;
  basicAuth?: { user: string; pass: string } | null;
  timeoutMs?: number;
  maxRetries?: number;
  fallbackDir?: string | null;
  /** Stream individual cases as they finish. Default: true. */
  liveStreaming?: boolean;
  /** Flush interval in ms. Default: 3000. */
  flushIntervalMs?: number;
  /** Heartbeat interval in ms — send empty POST when idle. Default: 10000. */
  heartbeatIntervalMs?: number;
}
