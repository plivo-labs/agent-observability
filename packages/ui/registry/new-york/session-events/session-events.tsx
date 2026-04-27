import { useState } from 'react'
import { ChevronDown, Clock } from 'lucide-react'
import dayjs from 'dayjs'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { useEvents } from '@/lib/observability-hooks'
import { getEventCreatedAt, getEventTimeRange } from '@/lib/observability-events'
import type { SessionEvent } from '@/lib/observability-types'

// Default Neo event badge palette. Consumers can override per-type badges by
// passing `typeBadgeClass` or by targeting `[data-event-type="..."]` in CSS.
export const DEFAULT_TYPE_BADGE_CLASS: Record<string, string> = {
  agent_state_changed: 'ev-tag-agent',
  user_state_changed: 'ev-tag-user',
  user_input_transcribed: 'ev-tag-user',
  conversation_item_added: 'ev-tag-conv',
  speech_created: 'ev-tag-speech',
  close: 'ev-tag-agent',
}

const FALLBACK_BADGE_CLASS = 'ev-tag-conv'

type TimeMode = 'relative' | 'absolute'

function summarize(event: SessionEvent): string {
  const e = event as Record<string, any>
  switch (event.type) {
    case 'agent_state_changed':
      return `agent: ${e.old_state} → ${e.new_state}`
    case 'user_state_changed':
      return `user: ${e.old_state} → ${e.new_state}`
    case 'user_input_transcribed': {
      const tag = e.is_final ? 'final' : 'partial'
      return `${tag}: "${e.transcript ?? ''}"`
    }
    case 'conversation_item_added': {
      const item = e.item ?? {}
      if (item.type === 'message') {
        const content = Array.isArray(item.content)
          ? item.content.join(' ')
          : item.content ?? ''
        const preview = String(content).slice(0, 120)
        const ellipsis = String(content).length > 120 ? '…' : ''
        return `${item.role}: "${preview}${ellipsis}"`
      }
      return `item: ${item.type ?? 'unknown'}`
    }
    case 'speech_created':
      return `speech (source=${e.source}${e.user_initiated ? ', user-initiated' : ''})`
    case 'close':
      return `session closed (reason=${e.reason ?? 'unknown'})`
    default:
      return event.type
  }
}

function formatRelative(offsetSec: number): string {
  const sign = offsetSec >= 0 ? '+' : '−'
  return `${sign}${Math.abs(offsetSec).toFixed(3)}s`
}

function formatAbsolute(unixSeconds: number): string {
  return dayjs(unixSeconds * 1000).format('HH:mm:ss.SSS')
}

const EventRow = ({
  event,
  relSeconds,
  eventTime,
  timeMode,
  badgeClass,
}: {
  event: SessionEvent
  relSeconds: number | null
  eventTime: number | null
  timeMode: TimeMode
  badgeClass: string
}) => {
  const timeLabel = eventTime == null
    ? 'n/a'
    : timeMode === 'relative'
      ? formatRelative(relSeconds ?? 0)
      : formatAbsolute(eventTime)
  return (
    <Collapsible className="ev-row-wrap group/event">
      <CollapsibleTrigger
        className={cn('ev-row', timeMode === 'absolute' && 'absolute-time')}
      >
        <ChevronDown
          size={13}
          className="caret -rotate-90 group-data-[state=open]/event:rotate-0"
        />
        <span className="t">
          {timeLabel}
        </span>
        <span
          data-event-type={event.type}
          className={cn('tag', badgeClass)}
        >
          <span>{event.type}</span>
        </span>
        <span className="msg">
          {summarize(event)}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-none data-[state=open]:animate-none">
        <pre
          className={cn('ev-detail', timeMode === 'absolute' && 'absolute-time')}
        >
          {JSON.stringify(event, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

export interface SessionEventsProps {
  /** Per-type badge className overrides — merged over the defaults. */
  typeBadgeClass?: Partial<Record<string, string>>
  /** Fallback className used when an event type has no mapping. */
  fallbackBadgeClass?: string
}

export const SessionEvents = ({
  typeBadgeClass,
  fallbackBadgeClass = FALLBACK_BADGE_CLASS,
}: SessionEventsProps = {}) => {
  const events = useEvents()
  const [timeMode, setTimeMode] = useState<TimeMode>('relative')

  const badgeClassFor = (type: string): string => {
    // User override wins; otherwise fall back to the component default.
    return (
      typeBadgeClass?.[type] ??
      DEFAULT_TYPE_BADGE_CLASS[type] ??
      fallbackBadgeClass
    )
  }

  if (events == null || events.length === 0) {
    return (
      <div className="events-card">
        <div className="py-8 text-center text-sm text-muted-foreground">
          No events captured for this session.
        </div>
      </div>
    )
  }

  const timeRange = getEventTimeRange(events)
  const t0 = timeRange?.start ?? 0
  const tEnd = timeRange?.end ?? t0

  const rangeLabel =
    timeMode === 'relative'
      ? `${formatRelative(0)} → ${formatRelative(tEnd - t0)}`
      : `${formatAbsolute(t0)} → ${formatAbsolute(tEnd)}`

  return (
    <div className="events-card">
      <div className="events-head">
        <div className="title">
          <span>{events.length} events</span>
          <span className="rng">{rangeLabel}</span>
        </div>
        <button
          type="button"
          className="timemode"
          onClick={() =>
            setTimeMode((m) => (m === 'relative' ? 'absolute' : 'relative'))
          }
        >
          <Clock size={12} />
          {timeMode === 'relative' ? 'Relative' : 'Absolute'}
        </button>
      </div>
      <div className="events-list">
        <ul>
          {events.map((event, i) => {
            const eventTime = getEventCreatedAt(event)
            return (
              <EventRow
                key={i}
                event={event}
                eventTime={eventTime}
                relSeconds={eventTime == null ? null : eventTime - t0}
                timeMode={timeMode}
                badgeClass={badgeClassFor(event.type)}
              />
            )
          })}
        </ul>
      </div>
    </div>
  )
}
