import type { SessionEvent } from '@/lib/observability-types'

export function getEventCreatedAt(event: SessionEvent): number | null {
  const value = (event as unknown as { created_at?: unknown }).created_at
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed / 1000 : null
  }
  return null
}

export function sortEventsByCreatedAt(
  events: readonly SessionEvent[] | null | undefined,
): SessionEvent[] | null {
  if (!events) return null
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const at = getEventCreatedAt(a.event)
      const bt = getEventCreatedAt(b.event)
      if (at == null && bt == null) return a.index - b.index
      if (at == null) return 1
      if (bt == null) return -1
      return at - bt || a.index - b.index
    })
    .map(({ event }) => event)
}

export function getEventTimeRange(
  events: readonly SessionEvent[] | null | undefined,
): { start: number; end: number } | null {
  if (!events) return null
  const eventTimes = events
    .map(getEventCreatedAt)
    .filter((value): value is number => value != null)
  if (eventTimes.length === 0) return null
  return {
    start: eventTimes[0],
    end: eventTimes[eventTimes.length - 1],
  }
}
