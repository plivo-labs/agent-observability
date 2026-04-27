import { useState } from 'react'
import { ChevronRight, Clock } from 'lucide-react'
import dayjs from 'dayjs'
import { Badge } from '@/components/ui/badge'
import { useEvents } from '@/lib/observability-hooks'
import { getEventCreatedAt, getEventTimeRange } from '@/lib/observability-events'
import type { SessionEvent } from '@/lib/observability-types'

/** Maps LiveKit event kinds to tonal Badge classes (success / warning /
 * info / accent-purple) so each event type reads at a glance. */
const EV_BADGE_TONE: Record<string, string> = {
  conversation_item_added:
    'bg-[hsl(var(--info-bg))] text-[hsl(var(--info))] border-[hsl(var(--info-border))]',
  speech_created:
    'bg-[hsl(var(--warning-bg))] text-[hsl(var(--warning-fg,var(--warning)))] border-[hsl(var(--warning-border))]',
  agent_state_changed:
    'bg-[hsl(var(--accent-purple-bg))] text-[hsl(var(--accent-purple))] border-[hsl(var(--accent-purple-border))]',
  user_state_changed:
    'bg-[hsl(var(--success-bg))] text-[hsl(var(--success-fg,var(--success)))] border-[hsl(var(--success-border))]',
  user_input_transcribed:
    'bg-[hsl(var(--success-bg))] text-[hsl(var(--success-fg,var(--success)))] border-[hsl(var(--success-border))]',
  close:
    'bg-[hsl(var(--warning-bg))] text-[hsl(var(--warning-fg,var(--warning)))] border-[hsl(var(--warning-border))]',
}
const EV_BADGE_FALLBACK =
  'bg-[hsl(var(--accent-purple-bg))] text-[hsl(var(--accent-purple))] border-[hsl(var(--accent-purple-border))]'

type TimeMode = 'relative' | 'absolute'

function formatRelative(offsetSec: number): string {
  const sign = offsetSec >= 0 ? '+' : '−'
  return `${sign}${Math.abs(offsetSec).toFixed(3)}s`
}

function formatAbsolute(unixSeconds: number): string {
  return dayjs(unixSeconds * 1000).format('HH:mm:ss.SSS')
}

/** Short one-line summary for an event — mirrors the design's ev-row message. */
function EventMessage({ event }: { event: SessionEvent }) {
  const e = event as Record<string, unknown>
  switch (event.type) {
    case 'agent_state_changed':
      return (
        <>
          agent: {String(e.old_state ?? '?')}
          <span className="arrow"> → </span>
          {String(e.new_state ?? '?')}
        </>
      )
    case 'user_state_changed':
      return (
        <>
          user: {String(e.old_state ?? '?')}
          <span className="arrow"> → </span>
          {String(e.new_state ?? '?')}
        </>
      )
    case 'user_input_transcribed': {
      const tag = e.is_final ? 'final' : 'partial'
      return (
        <>
          {tag}: <q>{String(e.transcript ?? '')}</q>
        </>
      )
    }
    case 'conversation_item_added': {
      const item = (e.item ?? {}) as Record<string, unknown>
      if (item.type === 'message') {
        const content = Array.isArray(item.content)
          ? item.content.join(' ')
          : String(item.content ?? '')
        const preview = content.slice(0, 120)
        const ellipsis = content.length > 120 ? '…' : ''
        return (
          <>
            {String(item.role ?? 'unknown')}: <q>{preview}{ellipsis}</q>
          </>
        )
      }
      return (
        <>
          item: <b>{String(item.type ?? 'unknown')}</b>
        </>
      )
    }
    case 'speech_created':
      return (
        <>
          speech <q>source={String(e.source ?? '?')}{e.user_initiated ? ', user-initiated' : ''}</q>
        </>
      )
    case 'close':
      return <>session closed (reason={String(e.reason ?? 'unknown')})</>
    default:
      return <>{event.type}</>
  }
}

export const SessionEvents = () => {
  const events = useEvents()
  const [timeMode, setTimeMode] = useState<TimeMode>('relative')
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())

  if (!events || events.length === 0) {
    return (
      <div className="events-card">
        <div style={{ padding: 48, textAlign: 'center', color: 'hsl(var(--tertiary))', font: 'var(--text-s-400)' }}>
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

  const toggle = (i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  return (
    <div className="events-card">
      <div className="events-head">
        <div className="title">
          {events.length} events <span className="rng">{rangeLabel}</span>
        </div>
        <button
          type="button"
          className="timemode"
          onClick={() => setTimeMode((m) => (m === 'relative' ? 'absolute' : 'relative'))}
        >
          <Clock size={12} /> {timeMode === 'relative' ? 'Relative' : 'Absolute'}
        </button>
      </div>
      <div className="events-list">
        {events.map((event, i) => {
          const createdAt = getEventCreatedAt(event)
          const timeLabel = createdAt == null
            ? 'n/a'
            : timeMode === 'relative'
              ? formatRelative(createdAt - t0)
              : formatAbsolute(createdAt)
          const tagTone = EV_BADGE_TONE[event.type] ?? EV_BADGE_FALLBACK
          const isOpen = expanded.has(i)
          return (
            <div key={i} className={`ev-row-wrap${isOpen ? ' open' : ''}`}>
              <div
                className="ev-row"
                onClick={() => toggle(i)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    toggle(i)
                  }
                }}
              >
                <div className="caret"><ChevronRight size={14} /></div>
                <div className="t">{timeLabel}</div>
                <div>
                  <Badge
                    data-event-type={event.type}
                    className={`rounded border px-2 py-0.5 font-mono text-[11px] font-semibold tracking-wide ${tagTone}`}
                  >
                    {event.type}
                  </Badge>
                </div>
                <div className="msg"><EventMessage event={event} /></div>
              </div>
              {isOpen && (
                <pre className="ev-detail">{JSON.stringify(event, null, 2)}</pre>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
