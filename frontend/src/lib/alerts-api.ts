// Dashboard-only API client for alert rules — intentionally NOT part of the
// packages/ui registry twins (precedent: not-found-page.tsx). Keeps the
// published observability-api surface untouched.

export type AlertTriggerType = 'evaluation_count' | 'outcome_count' | 'metric_threshold'

export type AlertMetric =
  | 'eval_fail_rate'
  | 'outcome_fail_rate'
  | 'latency_perceived_p95'
  | 'latency_llm_ttft_p95'
  | 'latency_tts_ttfb_p95'
  | 'latency_stt_p95'
  | 'interruption_rate'
  | 'session_volume'

/** Rate metrics store thresholds as 0..1 fractions; latency in ms;
 *  session_volume as a session count (and fires BELOW the floor). */
export const RATE_METRICS: ReadonlySet<AlertMetric> = new Set([
  'eval_fail_rate',
  'outcome_fail_rate',
  'interruption_rate',
])
export type AlertHttpMethod = 'POST' | 'PUT' | 'PATCH'

export interface AlertRule {
  id: string
  name: string
  enabled: boolean
  account_id: string | null
  agent_id: string | null
  trigger_type: AlertTriggerType
  metric: AlertMetric | null
  judge_name: string | null
  verdicts: string[]
  threshold_count: number | null
  threshold_value: number | null
  min_samples: number
  window_minutes: number
  webhook_url: string
  http_method: AlertHttpMethod
  secret: string | null
  headers: Record<string, string> | null
  last_fired_at: string | null
  created_at: string
  updated_at: string
}

/** Create payload — required fields are genuinely required, so
 *  `createRule({})` is a type error rather than a server 400. */
export interface AlertRuleCreate {
  name: string
  enabled: boolean
  trigger_type: AlertTriggerType
  metric: AlertMetric | null
  judge_name: string | null
  verdicts: string[]
  threshold_count: number | null
  threshold_value: number | null
  min_samples: number
  window_minutes: number
  agent_id: string | null
  account_id: string | null
  webhook_url: string
  http_method: AlertHttpMethod
  secret: string | null
  headers: Record<string, string> | null
}

export type AlertRulePatch = Partial<AlertRuleCreate>

export interface AlertFiring {
  id: string
  rule_id: string
  window_start: string
  window_end: string
  matched_count: number
  total_count: number | null
  observed_value: number | null
  sample_session_ids: string[]
  status: 'pending' | 'delivered' | 'failed'
  attempt_count: number
  next_attempt_at: string
  last_attempt_at: string | null
  response_status: number | null
  last_error: string | null
  created_at: string
}

export interface WebhookAttempt {
  id: string
  rule_id: string | null
  rule_name: string | null
  firing_id: string | null
  kind: 'firing' | 'test'
  url: string
  http_method: string
  attempt_number: number
  ok: boolean
  response_status: number | null
  error: string | null
  duration_ms: number | null
  created_at: string
}

export interface WebhookStats {
  range: string
  total_attempts: number
  accepted: number
  acceptance_rate: number | null
  avg_duration_ms: number | null
  buckets: Array<{ bucket_start: string; attempts: number; accepted: number }>
  rule_breakdown: Array<{
    rule_id: string | null
    rule_name: string | null
    attempts: number
    accepted: number
  }>
}

export interface TestSendResult {
  ok: boolean
  response_status: number | null
  error: string | null
  duration_ms: number
}

interface ListResponse<T> {
  objects: T[]
  meta: { total_count: number; limit: number; offset: number }
}

export function createAlertsApi(baseUrl: string) {
  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, init)
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`
      try {
        const body = await res.json()
        if (body?.error?.message) detail = body.error.message
      } catch {}
      throw new Error(detail)
    }
    return res.json()
  }

  const json = (body: unknown): RequestInit => ({
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  return {
    listRules: (limit = 50, offset = 0) =>
      fetchJson<ListResponse<AlertRule>>(`/alert-rules?limit=${limit}&offset=${offset}`),
    createRule: (input: AlertRuleCreate) =>
      fetchJson<AlertRule>('/alert-rules', { method: 'POST', ...json(input) }),
    updateRule: (id: string, patch: AlertRulePatch) =>
      fetchJson<AlertRule>(`/alert-rules/${id}`, { method: 'PATCH', ...json(patch) }),
    deleteRule: (id: string) =>
      fetchJson<{ deleted: boolean }>(`/alert-rules/${id}`, { method: 'DELETE' }),
    testRule: (id: string) =>
      fetchJson<TestSendResult>(`/alert-rules/${id}/test`, { method: 'POST' }),
    listFirings: (ruleId: string, limit = 20) =>
      fetchJson<ListResponse<AlertFiring>>(`/alert-rules/${ruleId}/firings?limit=${limit}`),
    listAttempts: (ruleId?: string | null, limit = 50) =>
      fetchJson<ListResponse<WebhookAttempt>>(
        `/alerts/webhook-attempts?limit=${limit}${ruleId ? `&rule_id=${ruleId}` : ''}`,
      ),
    webhookStats: (range = '7d') => fetchJson<WebhookStats>(`/alerts/webhook-stats?range=${range}`),
  }
}

export type AlertsApi = ReturnType<typeof createAlertsApi>

/** Shared dashboard instance — the alert pages all talk to /api. */
export const alertsApi = createAlertsApi('/api')
