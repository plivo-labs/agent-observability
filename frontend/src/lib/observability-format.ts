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

// Two-letter initials from a display name, e.g. "Happy Path" → "HP".
export const initials = (n: string): string => n.split(' ').map((w) => w[0]).slice(0, 2).join('')

// Human "time ago" / "in …" for an ISO timestamp, coarsened to s/m/h/d.
export function rel(ts: string | null): string {
  if (!ts) return '—'
  const d = (Date.now() - new Date(ts).getTime()) / 1000
  const fmt = (n: number, u: string) => `${Math.round(n)}${u}`
  if (d < 0) {
    const a = -d
    return 'in ' + (a < 60 ? fmt(a, 's') : a < 3600 ? fmt(a / 60, 'm') : fmt(a / 3600, 'h'))
  }
  return (d < 60 ? fmt(d, 's') : d < 3600 ? fmt(d / 60, 'm') : d < 86400 ? fmt(d / 3600, 'h') : fmt(d / 86400, 'd')) + ' ago'
}

// Compact cadence label for a minute count, e.g. 1440 → "1d", 60 → "1h", 30 → "30m".
export const interval = (m: number): string => (m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`)

// Tailwind text-color token for a pass-rate (0–100), null = muted.
export const rateTone = (r: number | null): string => (r == null ? 'text-muted-foreground' : r >= 80 ? 'text-success' : r >= 50 ? 'text-warning' : 'text-destructive')

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
