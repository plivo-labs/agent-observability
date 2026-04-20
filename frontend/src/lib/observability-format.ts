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
