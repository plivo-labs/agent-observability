// Presentation helpers for alert rules — shared by the rules table and
// the firings drawer. Dashboard-only (not a registry twin).

import type { AlertRule, AlertTriggerType } from '@/lib/alerts-api'

export const TRIGGER_LABEL: Record<AlertTriggerType, string> = {
  evaluation_count: 'Eval verdicts',
  outcome_count: 'Outcomes',
  pass_rate: 'Pass rate',
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

/** Human summary of the trigger condition — the table's load-bearing cell. */
export function triggerSummary(rule: AlertRule): string {
  if (rule.trigger_type === 'pass_rate') {
    const pct = rule.threshold_pass_rate != null ? Math.round(rule.threshold_pass_rate * 100) : '?'
    const judge = rule.judge_name ? ` · ${rule.judge_name}` : ''
    return `< ${pct}% pass over ${windowLabel(rule.window_minutes)} (min ${rule.min_samples})${judge}`
  }
  const what = rule.verdicts.join('/')
  const judge = rule.trigger_type === 'evaluation_count' && rule.judge_name ? ` · ${rule.judge_name}` : ''
  return `≥ ${rule.threshold_count ?? '?'} ${what} in ${windowLabel(rule.window_minutes)}${judge}`
}
