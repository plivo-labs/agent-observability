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
