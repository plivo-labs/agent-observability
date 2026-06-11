// Formatting utilities for session metrics display

import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

export const formatMs = (ms: number): string => {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export const formatDuration = (ms: number | null): string => {
  if (ms == null) return '—'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

export const formatDate = (iso: string | null): string => {
  if (!iso) return '—'
  return dayjs(iso).format('MMM D, YYYY h:mm A')
}

/** Compact token-count rendering — millions and thousands rounded for at-
 *  a-glance reading. 1234 → "1.2K", 1_234_567 → "1.2M". Zero renders "0"
 *  (callers decide whether to em-dash when no data). */
export const formatTokens = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}M`
  }
  if (n >= 1_000) {
    const k = n / 1000
    return `${k >= 10 ? k.toFixed(0) : k.toFixed(1)}K`
  }
  return n.toLocaleString('en-US')
}

/** Compact USD rendering. <$0.01 → "<$0.01" so tiny but non-zero costs
 *  don't get rounded to $0.00 and look like "we couldn't price you". */
export const formatCost = (usd: number | null | undefined): string => {
  if (usd == null || !Number.isFinite(usd)) return '—'
  if (usd === 0) return '$0.00'
  if (usd > 0 && usd < 0.01) return '<$0.01'
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString('en-US')}`
  return `$${usd.toFixed(2)}`
}

/** Ratio (0–1) → whole-percent string. Nullish renders "—" so callers can
 *  pass optional summary fields straight through. */
export const formatPercent = (ratio: number | null | undefined): string =>
  ratio == null ? '—' : `${Math.round(ratio * 100)}%`

/** Exact thousands-grouped millisecond rendering for KPI tiles —
 *  "1,234 ms" (vs formatMs's compact "1.23s"). Nullish renders "—". */
export const formatMsExact = (value: number | null | undefined): string =>
  value == null ? '—' : `${new Intl.NumberFormat().format(value)} ms`

/** X-axis tick formatter for time-bucketed stats charts. Hour buckets
 *  (24h/7d ranges) render HH:MM; day buckets (30d) render MM-DD. */
export const bucketTickFormatter = (range: string) => {
  if (range === '30d') {
    return (iso: string) => {
      const d = new Date(iso)
      return `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d
        .getDate()
        .toString()
        .padStart(2, '0')}`
    }
  }
  return (iso: string) => {
    const d = new Date(iso)
    return `${d.getHours().toString().padStart(2, '0')}:${d
      .getMinutes()
      .toString()
      .padStart(2, '0')}`
  }
}

// ── Tone thresholds + helpers ───────────────────────────────────────────────
// Centralized here so the latency / ASR / pass-rate thresholds live in exactly
// one place. Consumed by the eval-run-detail KPIs (latencyTone / asrTone /
// passRateTone) and the per-session metric summary (perceivedLatencyTone).

// Run-level eval thresholds.
export const TTFT_BAD_MS = 10_000
export const TTFB_BAD_MS = 1_500
export const ASR_BAD = 0.88
export const ASR_WARN = 0.92

// Per-session user-perceived speech latency thresholds. Good < 1s, warn 1–2s,
// bad > 2s. Distinct from the run-level TTFT/TTFB thresholds above because
// they describe a different metric (end-to-end perceived response time).
export const PERCEIVED_LATENCY_WARN_MS = 1000
export const PERCEIVED_LATENCY_BAD_MS = 2000

export type ValueTone = 'default' | 'good' | 'warn' | 'bad' | 'mute'

export const valueToneClass: Record<ValueTone, string> = {
  default: 'text-foreground',
  good: 'text-success-fg',
  warn: 'text-warning-fg',
  bad: 'text-destructive',
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

/** Three-tier tone for per-session user-perceived latency. Returns undefined
 *  when there's no value so callers can leave the tile untinted. */
export const perceivedLatencyTone = (ms: number | null): 'good' | 'warn' | 'bad' | undefined => {
  if (ms == null) return undefined
  if (ms < PERCEIVED_LATENCY_WARN_MS) return 'good'
  if (ms < PERCEIVED_LATENCY_BAD_MS) return 'warn'
  return 'bad'
}

// Split a ms value into a numeric part and unit so callers can render the
// unit subdued without re-parsing the formatted string.
export function fmtMsParts(ms: number | null | undefined): { value: string; unit: string | null } {
  if (ms == null) return { value: '—', unit: null }
  if (ms < 1) return { value: '<1', unit: 'ms' }
  if (ms < 1000) return { value: String(Math.round(ms)), unit: 'ms' }
  return { value: (ms / 1000).toFixed(2), unit: 's' }
}

export const computeAvg = (values: number[]) => {
  if (!values.length) return 0
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length)
}

export const computePercentile = (values: number[], p: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1)
  return sorted[idx]
}

// Stringifies a tool-call argument or a tool-result output for display.
// Tries each format in order and returns the first one that parses:
//   1. Strict JSON — the right format. Tools that return native dicts via the
//      LiveKit Python SDK serialize this way.
//   2. Python repr — when a tool ran `str(dict)` instead of `json.dumps(dict)`,
//      we get single quotes, capitalized True/False/None. This is a *best
//      effort* recovery; it breaks if any string value contains an apostrophe
//      (e.g. "O'Brien") because the heuristic flips every `'` to `"`. The
//      proper fix is producer-side — make tools return JSON-shaped output.
//   3. Raw string — plain text outputs (e.g. "shipped") render as-is so they
//      aren't wrapped in extra quotes.
// Non-strings (already-an-object/array) are JSON-stringified directly.
export function formatToolValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value !== 'string') return JSON.stringify(value, null, 2)
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    // Python-repr fallback. Only attempt for strings that look like a dict /
    // list — don't munge plain text containing the word `True`.
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const jsonish = value
          .replace(/(?<!\\)'/g, '"')
          .replace(/\bTrue\b/g, 'true')
          .replace(/\bFalse\b/g, 'false')
          .replace(/\bNone\b/g, 'null')
        return JSON.stringify(JSON.parse(jsonish), null, 2)
      } catch {
        // fall through to raw string
      }
    }
    return value
  }
}
