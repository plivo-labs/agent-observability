import type { CaseStatus, EvalCaseRow, EvalRunDetail, RunEvent } from '@/lib/observability-types'

// ── Latency / ASR thresholds ────────────────────────────────────────────────

export const TTFT_BAD_MS = 10_000
export const TTFB_BAD_MS = 1_500
export const ASR_BAD = 0.88
export const ASR_WARN = 0.92

// ── Chart colors ────────────────────────────────────────────────────────────

export const COLOR_TTFT = 'hsl(var(--accent-purple))'
export const COLOR_TTFB = 'hsl(var(--success-fg,var(--success)))'

// ── Metrics view model ──────────────────────────────────────────────────────

// What kind of latency story this run tells.
//   'voice' — has TTS, so TTFB is meaningful → show TTFB column, pipeline
//             breakdown chart, p95 TTFB KPI, dual-line latency.
//   'text'  — no TTS, so TTFB is always null → hide TTFB sites, show
//             duration-per-case instead of pipeline breakdown.
// Derived once from run + cases. Adding a third modality means changing
// this derivation, not every render site.
export type MetricsView = 'voice' | 'text'

export function detectMetricsView(run: EvalRunDetail, cases: EvalCaseRow[]): MetricsView {
  const hasTtfb =
    run.ttfb_p95_ms != null ||
    run.ttfb_avg_ms != null ||
    cases.some((c) => c.ttfb_avg_ms != null)
  return hasTtfb ? 'voice' : 'text'
}

// ── Enriched case + run stats shape (shared by table + KPI strip) ───────────

export type EnrichedCase = EvalCaseRow & {
  asr: number | null
  judgePass: number
  judgeFail: number
  ttftBad: boolean
  ttfbBad: boolean
  asrBad: boolean
  asrWarn: boolean
  hasInterrupt: boolean
}

export interface RunStats {
  passRate: number
  totalToolCalls: number
  totalInterrupts: number
  avgToolCallsPerCase: number
  avgTokensPerCase: number
  avgCostPerCase: number | null
  avgAsr: number | null
}

export interface OverCasesDatum {
  idx: number
  ttft: number | null
  ttfb: number | null
  duration: number | null
  status: CaseStatus
}

export type StatusFilter = CaseStatus | 'all'

// ── Tones / formatting ──────────────────────────────────────────────────────

export type ValueTone = 'default' | 'good' | 'warn' | 'bad' | 'mute'

export const valueToneClass: Record<ValueTone, string> = {
  default: 'text-foreground',
  good: 'text-[hsl(var(--success-fg,var(--success)))]',
  warn: 'text-[hsl(var(--warning-fg,var(--warning)))]',
  bad: 'text-[hsl(var(--destructive))]',
  mute: 'text-muted-foreground',
}

export const latencyTone = (ms: number | null, badMs: number): ValueTone =>
  ms == null ? 'mute' : ms > badMs ? 'bad' : 'default'

export const asrTone = (avg: number | null): ValueTone => {
  if (avg == null) return 'mute'
  if (avg < ASR_BAD) return 'bad'
  if (avg < ASR_WARN) return 'warn'
  return 'good'
}

export const passRateTone = (pct: number): ValueTone =>
  pct >= 90 ? 'good' : pct >= 70 ? 'warn' : 'bad'

// Split a ms value into a numeric part and unit so callers can render the
// unit subdued without re-parsing the formatted string.
export function fmtMsParts(ms: number | null | undefined): { value: string; unit: string | null } {
  if (ms == null) return { value: '—', unit: null }
  if (ms < 1) return { value: '<1', unit: 'ms' }
  if (ms < 1000) return { value: String(Math.round(ms)), unit: 'ms' }
  return { value: (ms / 1000).toFixed(2), unit: 's' }
}

export function caseAsrConfidence(events: RunEvent[]): number | null {
  const vals: number[] = []
  for (const ev of events) {
    if (ev.type !== 'message') continue
    const m = ev.metrics
    if (!m) continue
    for (const k of Object.keys(m)) {
      if (
        k === 'user_transcript_confidence' ||
        k === 'stt_confidence' ||
        k === 'asr_confidence'
      ) {
        const v = m[k]
        if (typeof v === 'number' && Number.isFinite(v)) vals.push(v)
      }
    }
  }
  if (vals.length === 0) return null
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length
  return avg > 1 ? avg / 100 : avg
}
