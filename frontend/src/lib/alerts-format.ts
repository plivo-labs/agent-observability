// Presentation helpers for alert rules — shared by the rules table, the
// rule dialog, and the firings drawer. Dashboard-only (not a registry twin).

import { RATE_METRICS, type AlertMetric, type AlertRule } from '@/lib/alerts-api'

export const TRIGGER_LABEL: Record<AlertRule['trigger_type'], string> = {
  evaluation_count: 'Eval verdicts',
  outcome_count: 'Outcomes',
  metric_threshold: 'Metric',
}

export const METRIC_LABEL: Record<AlertMetric, string> = {
  eval_fail_rate: 'Eval fail rate',
  outcome_fail_rate: 'Outcome failure rate',
  latency_perceived_p95: 'p95 perceived latency',
  latency_llm_ttft_p95: 'p95 LLM TTFT',
  latency_tts_ttfb_p95: 'p95 TTS TTFB',
  latency_stt_p95: 'p95 STT delay',
  interruption_rate: 'Interruption rate',
}

export type MetricKind = 'rate' | 'latency'

export function metricKind(metric: AlertMetric): MetricKind {
  return RATE_METRICS.has(metric) ? 'rate' : 'latency'
}

export const WINDOW_OPTIONS = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 240, label: '4 hours' },
  { minutes: 1440, label: '24 hours' },
]

export function windowLabel(minutes: number): string {
  return WINDOW_OPTIONS.find((w) => w.minutes === minutes)?.label ?? `${minutes}m`
}

/** Render a metric value in its native unit (rate %, latency ms). */
export function metricValue(metric: AlertMetric, value: number | null | undefined): string {
  if (value == null) return '—'
  return metricKind(metric) === 'rate'
    ? `${Math.round(value * 100)}%`
    : `${Math.round(value).toLocaleString()} ms`
}

/** Human summary of the trigger condition — the table's load-bearing cell. */
export function triggerSummary(rule: AlertRule): string {
  const win = windowLabel(rule.window_minutes)
  if (rule.trigger_type === 'metric_threshold' && rule.metric) {
    const value = metricValue(rule.metric, rule.threshold_value)
    const judge = rule.judge_name ? ` · ${rule.judge_name}` : ''
    const samples = rule.min_samples > 1 ? ` (min ${rule.min_samples})` : ''
    return `> ${value} over ${win}${samples}${judge}`
  }
  const what = rule.verdicts.join('/')
  const judge = rule.trigger_type === 'evaluation_count' && rule.judge_name ? ` · ${rule.judge_name}` : ''
  return `≥ ${rule.threshold_count ?? '?'} ${what} in ${win}${judge}`
}
