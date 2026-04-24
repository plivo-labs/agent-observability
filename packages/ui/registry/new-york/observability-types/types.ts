// Session metrics types for the dashboard UI

export interface TurnRecord {
  turn_number: number
  turn_id: string
  user_text: string | null
  agent_text: string | null
  agent_first: boolean
  interrupted: boolean
  user_started_speaking_at?: string
  user_stopped_speaking_at?: string
  agent_started_speaking_at?: string
  agent_stopped_speaking_at?: string
  user_perceived_ms?: number
  stt_delay_ms?: number
  llm_ttft_ms?: number
  tts_ttfb_ms?: number
  turn_decision_ms?: number
  /** STT confidence for the user utterance, 0–1. Populated by the STT
   * plugin (Deepgram, Google, …); absent when the plugin doesn't report
   * confidence. */
  user_transcript_confidence?: number
  llm_prompt_tokens?: number
  llm_completion_tokens?: number
  llm_total_tokens?: number
  tts_characters?: number
  tool_calls?: ToolCallRecord[]
  llm_tokens_per_second?: number
  llm_cache_hit_ratio?: number
  llm_duration_ms?: number
  llm_cache_read_tokens?: number
  stt_audio_duration_ms?: number
  tts_audio_duration_ms?: number
  num_interruptions?: number
  num_backchannels?: number
  stt_provider?: string
  stt_model?: string
  llm_provider?: string
  llm_model?: string
  tts_provider?: string
  tts_model?: string
  stt_timestamp?: number
  llm_timestamp?: number
  tts_timestamp?: number
  endpointing_min_delay_ms?: number
  endpointing_max_delay_ms?: number
  pipeline?: string
  agent_tool_id?: string
}

export interface ToolCallRecord {
  name: string
  call_id?: string
  arguments: Record<string, unknown>
  output?: string
  is_error?: boolean
  result?: unknown
  turn_number: number
  timestamp: string
}

export interface LatencyPercentiles {
  p50: number
  p90: number
  p95: number
  avg: number
}

export interface MetricsSummary {
  total_turns: number
  total_llm_tokens: number
  total_llm_prompt_tokens: number
  total_llm_completion_tokens: number
  total_tts_characters: number
  total_tool_calls: number
  interruptions: number
  avg_user_perceived_ms?: number
  p95_user_perceived_ms?: number
  latency?: Record<string, LatencyPercentiles>
  usage?: {
    total_llm_tokens: number
    total_llm_prompt_tokens: number
    total_llm_completion_tokens: number
    total_llm_cached_tokens: number
    total_tts_characters: number
    total_tts_audio_duration_ms: number
    total_stt_audio_duration_ms: number
    avg_llm_tokens_per_second?: number
    avg_llm_cache_hit_ratio?: number
  }
  interruption?: {
    total_interrupted_turns: number
    total_interruptions: number
    total_backchannels: number
  }
  providers?: {
    stt_provider?: string
    stt_model?: string
    llm_provider?: string
    llm_model?: string
    tts_provider?: string
    tts_model?: string
  }
  errors?: Array<{ error: string; source: string; timestamp: string }>
}

export interface SessionMetrics {
  turns: TurnRecord[]
  tool_calls: ToolCallRecord[]
  summary: MetricsSummary
}

export type Transport = 'sip' | 'audio_stream'

export interface SessionsFilters {
  accountId?: string
  startedFrom?: string
  startedTo?: string
}

export interface AgentSessionRow {
  id: number
  session_id: string
  account_id: string | null
  state: string
  transport: Transport | null
  started_at: string | null
  ended_at: string
  duration_ms: number | null
  turn_count: number
  has_stt: boolean
  has_llm: boolean
  has_tts: boolean
  chat_history: ChatItem[] | null
  session_metrics: SessionMetrics | null
  events: SessionEvent[] | null
  options: Record<string, unknown> | null
  record_url: string | null
  created_at: string
}

export interface SessionEvent {
  type: string
  created_at: number
  [key: string]: unknown
}

export interface ChatItem {
  id?: string
  type: string
  role?: string
  message?: { role: string; content: string }
  content?: string
  metrics?: Record<string, number>
}

export interface PlivoMeta {
  limit: number
  offset: number
  total_count: number
  next: string | null
  previous: string | null
}

export interface PlivoListResponse<T> {
  api_id: string
  meta: PlivoMeta
  objects: T[]
}

// ── Eval payload types ──────────────────────────────────────────────────────

export type CaseStatus = 'passed' | 'failed' | 'errored' | 'skipped'

export type JudgmentVerdict = 'pass' | 'fail' | 'maybe'

export interface JudgmentResult {
  intent: string
  verdict: JudgmentVerdict
  reasoning: string
}

export type FailureKind = 'assertion' | 'error' | 'timeout' | 'judge_failed'

export interface Failure {
  kind: FailureKind
  message?: string
  stack?: string
  expected_event_index?: number
}

export interface RunEventMessage {
  type: 'message'
  role?: string
  content?: string
  interrupted?: boolean
  metrics?: Record<string, number | string | null> | null
}

export interface RunEventFunctionCall {
  type: 'function_call'
  name?: string
  arguments?: unknown
  call_id?: string
}

export interface RunEventFunctionCallOutput {
  type: 'function_call_output'
  output?: string
  is_error?: boolean
  call_id?: string
}

export interface RunEventAgentHandoff {
  type: 'agent_handoff'
  from_agent?: string
  to_agent?: string
}

export type RunEvent =
  | RunEventMessage
  | RunEventFunctionCall
  | RunEventFunctionCallOutput
  | RunEventAgentHandoff

export interface CiMetadata {
  provider?: string
  run_url?: string
  git_sha?: string
  git_branch?: string
  commit_message?: string
  [k: string]: unknown
}

export interface EvalRunRow {
  run_id: string
  account_id: string | null
  agent_id: string | null
  framework: string
  framework_version: string | null
  sdk: string | null
  sdk_version: string | null
  started_at: string
  finished_at: string
  duration_ms: number | null
  total: number
  passed: number
  failed: number
  errored: number
  skipped: number
  ci: CiMetadata | null
  created_at: string
}

export interface EvalCaseRow {
  case_id: string
  run_id: string
  name: string
  file: string | null
  status: CaseStatus
  duration_ms: number | null
  user_input: string | null
  events: RunEvent[]
  judgments: JudgmentResult[]
  failure: Failure | null
  created_at: string
}

export interface EvalRunDetail extends EvalRunRow {
  api_id?: string
  cases: EvalCaseRow[]
}

export interface EvalsFilters {
  agentId?: string
  framework?: string[]
  accountId?: string
  startedFrom?: string
  startedTo?: string
}
