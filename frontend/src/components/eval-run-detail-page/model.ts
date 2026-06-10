import type { CaseStatus, EvalCaseRow, EvalRunDetail, RunEvent } from '@/lib/observability-types'

// ── Latency / ASR thresholds + tones ────────────────────────────────────────
// The thresholds and tone helpers now live in observability-format so the same
// values back both the eval-run-detail KPIs and the per-session metric summary.
// Re-exported here so this module stays the one import surface for the
// decomposed eval-run-detail files.
export {
  TTFT_BAD_MS,
  TTFB_BAD_MS,
  ASR_BAD,
  ASR_WARN,
  asrTone,
  fmtMsParts,
  latencyTone,
  passRateTone,
  valueToneClass,
} from '@/lib/observability-format'
export type { ValueTone } from '@/lib/observability-format'

// ── Chart colors ────────────────────────────────────────────────────────────

export const COLOR_TTFT = 'var(--accent-purple)'
export const COLOR_TTFB = 'var(--success-fg, var(--success))'

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

// ── ASR confidence (derived per-case) ───────────────────────────────────────

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
