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

export type Transport = 'sip' | 'audio_stream' | 'text' | 'terminal_text' | string

export interface SessionsFilters {
  accountId?: string
  /** Exact-match — comes from the agent dashboard URL param, not free-text. */
  agentId?: string
  /** Exact-match too; kept for legacy callers that scope by display name. */
  agentName?: string
  startedFrom?: string
  startedTo?: string
  /** Multi-value — server accepts comma-separated list. */
  transport?: string[]
}

/**
 * AgentRow — one row per distinct (agent_id, account_id) observed in
 * either agent_transport_sessions or eval_runs. Agents are unique within
 * an account, so the same agent_id under a different account is a
 * different row.
 *
 * `agent_id` is the URL path param; `account_id` is the optional query
 * disambiguator (?account_id=…) when an agent_id spans multiple accounts.
 * `agent_name` is the human-readable label and may be null on agents
 * that ship only via CI (the pytest/vitest plugins don't emit a name).
 */
/**
 * Modality derived from the set of transports an agent has run across.
 * `mixed` when the agent has both audio-bearing and text-bearing
 * sessions; `null` when there are no sessions yet (CI-eval-only agent).
 */
export type Modality = 'voice' | 'text' | 'mixed' | null

export interface AgentRow {
  agent_id: string | null
  account_id: string | null
  agent_name: string | null
  modality: Modality
  /** Distinct transports observed across this agent's sessions. Empty
   * for agents that only have eval runs. */
  transports: string[]
  session_count: number
  session_count_24h: number
  last_session_at: string | null
  p95_duration_ms: number | null
  eval_run_count: number
  last_eval_run_at: string | null
  /** 0..1 over all cases across all CI eval runs for this agent. */
  eval_pass_rate: number | null
}

/**
 * One row per session that has conversation-eval data — `evaluations` and
 * `tags` are pulled inline so the table can render verdict counts +
 * judge chips without a second fetch.
 */
export interface ConversationEvalSummary {
  session_id: string
  account_id: string | null
  agent_id: string | null
  agent_name: string | null
  ended_at: string
  duration_ms: number | null
  pass_count: number
  fail_count: number
  maybe_count: number
  judge_names: string[]
  outcome: string | null
  outcome_reason: string | null
  evaluations: SessionExternalEvaluation[]
}

export interface AgentsFilters {
  accountId?: string
  /** Exact-match filter on agent_id. */
  agentId?: string
  /** Free-text case-insensitive substring filter on agent name. */
  agentName?: string
}

export type AgentStatsRange = '24h' | '7d' | '30d'

export interface AgentStatsBucket {
  bucket_start: string
  session_count: number
  avg_duration_ms: number | null
  p95_user_perceived_ms: number | null
  estimated_cost_usd: number | null
}

export interface AgentStats {
  range: AgentStatsRange
  total_sessions: number
  total_estimated_cost_usd: number | null
  avg_turn_count: number | null
  p50_user_perceived_ms: number | null
  p95_user_perceived_ms: number | null
  p99_user_perceived_ms: number | null
  llm_pass_rate: number | null
  ci_pass_rate: number | null
  buckets: AgentStatsBucket[]
  transport_breakdown: Array<{ transport: string | null; count: number }>
  provider_breakdown: Array<{ provider: string; model: string; count: number }>
}

export type SessionEvaluationVerdict = 'pass' | 'fail' | 'maybe' | string

export interface SessionTag {
  name: string
  metadata: Record<string, unknown> | null
  source: string
  observed_at: string | null
  created_at: string
  updated_at?: string
}

export interface SessionExternalEvaluation {
  source: string
  judge_name: string
  tag: string | null
  verdict: SessionEvaluationVerdict | null
  reasoning: string | null
  instructions: string | null
  observed_at: string | null
  raw: Record<string, unknown> | null
  created_at: string
}

export interface SessionOutcome {
  source: string
  outcome: string
  reason: string | null
  observed_at: string | null
  raw: Record<string, unknown> | null
  created_at: string
  updated_at?: string
}

export interface AgentSessionRow {
  id: number
  session_id: string
  account_id: string | null
  /** Developer-supplied stable identifier. The primary key for the agent
   * dashboard's virtual entity; populated from `log.attributes.agent_id`
   * on the OTLP session-report or an `agent_id:<value>` session tag. */
  agent_id: string | null
  /** Developer-supplied display label. Populated from the analogous
   * `agent_name` attribute / tag. May lag the canonical id in the rare
   * case where the producer renamed without re-emitting. */
  agent_name: string | null
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
  tags?: SessionTag[]
  evaluations?: SessionExternalEvaluation[]
  outcome?: SessionOutcome | null
  record_url: string | null
  estimated_cost_usd: number | null
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
  /** Per-turn metrics attached by LiveKit (e.g. llm_node_ttft, *_speaking_at).
   * Shape is open — LiveKit may add keys; the UI renders numeric keys generically. */
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

/**
 * Run lifecycle status. Plugins post 'running' at session-start, then
 * 'completed' (or 'failed') at session-finish. The server-side read
 * overlay flips stale 'running' runs (>60s no heartbeat) to 'completed'
 * so a crashed plugin doesn't leave runs visually stuck.
 */
export type EvalRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface EvalRunRow {
  run_id: string
  /** Optional human-readable label (e.g. "Nightly smoke", "PR #482").
   * Set via `--agent-observability-run-name` CLI flag or the
   * AGENT_OBSERVABILITY_RUN_NAME env var on the plugin side. */
  name: string | null
  account_id: string | null
  agent_id: string | null
  /** Human-readable agent label resolved from the agents table at read
   * time (LEFT JOIN). Null when no agent row exists for the eval's
   * agent_id (e.g. legacy data) or when agent_id itself is null. */
  agent_name: string | null
  /** Agent framework family — `livekit` / `pipecat` / …. Null when no
   *  known agent-framework package was detected by the plugin. */
  framework: string | null
  framework_version: string | null
  /** Test framework that ran the suite — `pytest` / `vitest` / …. */
  testing_framework: string
  testing_framework_version: string | null
  started_at: string
  /** Null while a run is in-flight (status='running'). The plugin's
   *  session-finish POST populates it via INSERT ON CONFLICT DO UPDATE. */
  finished_at: string | null
  duration_ms: number | null
  total: number
  passed: number
  failed: number
  errored: number
  skipped: number
  ci: CiMetadata | null
  /** Effective status — already passed through the server's read-time
   *  overlay (running rows with last_activity_at >1h ago flip to
   *  'completed'), so consumers can render directly. */
  status: EvalRunStatus
  /** Server-stamped timestamp of the last write to this row. Null on
   *  pre-status rows (legacy). Drives the read-time TTL overlay. */
  last_activity_at: string | null
  /** Latency p50/p95/avg for "time to first token" — extracted from
   *  per-turn LiveKit metrics on assistant messages. Null when no
   *  samples (e.g. text-only suites or first-POST-only runs). */
  ttft_p50_ms: number | null
  ttft_p95_ms: number | null
  ttft_avg_ms: number | null
  /** TTFB — "time to first byte" for TTS output. Null for text-only
   *  suites that don't run a TTS pipeline. UI auto-hides TTFB cards
   *  when these are null across the run. */
  ttfb_p50_ms: number | null
  ttfb_p95_ms: number | null
  ttfb_avg_ms: number | null
  turn_count: number
  tool_call_count: number
  interruption_count: number
  agent_handoff_count: number
  /** Number of TTFT samples that contributed to the percentiles —
   *  useful for sanity-checking small-sample runs. */
  ttft_sample_count: number
  /** Sum of LLM token counts across all assistant-message events.
   *  `total_tokens` trusts the event's `llm_total_tokens` when
   *  present, else `prompt + completion`. `cached_prompt_tokens` is
   *  a subset of `prompt_tokens` (cache % = cached / prompt). */
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cached_prompt_tokens: number
  /** Estimated USD cost from per-message provider:model pricing.
   *  Null when at least one usage sample couldn't be priced
   *  (mixed-model run with an unknown model). Zero when there are
   *  no tokens to price. */
  estimated_cost_usd: number | null
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
  /** Per-case latency metrics, computed at ingest from the events
   *  array. Same shape and null-when-no-samples convention as the
   *  run-level metrics on `EvalRunRow`. */
  ttft_p50_ms: number | null
  ttft_p95_ms: number | null
  ttft_avg_ms: number | null
  ttfb_p50_ms: number | null
  ttfb_p95_ms: number | null
  ttfb_avg_ms: number | null
  turn_count: number
  tool_call_count: number
  interruption_count: number
  agent_handoff_count: number
  ttft_sample_count: number
  /** Sum of LLM token counts across this case's assistant-message
   *  events. Same shape and semantics as the run-level fields. */
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cached_prompt_tokens: number
  /** Estimated USD cost for this case. Same null/zero/positive
   *  semantics as the run-level field. */
  estimated_cost_usd: number | null
  created_at: string
}

export interface EvalRunDetail extends EvalRunRow {
  api_id?: string
  cases: EvalCaseRow[]
}

export interface EvalsFilters {
  agentId?: string
  /** Multi-value agent-framework filter (`livekit` / `pipecat` / …). */
  framework?: string[]
  /** Multi-value test-framework filter (`pytest` / `vitest` / …). */
  testingFramework?: string[]
  accountId?: string
  startedFrom?: string
  startedTo?: string
}
