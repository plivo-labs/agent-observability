import { useState } from 'react'
import { ChevronRight, Clock } from 'lucide-react'
import dayjs from 'dayjs'
import { useEvents } from '@/lib/observability-hooks'
import type { SessionEvent } from '@/lib/observability-types'

/** Maps LiveKit event kinds to the design's `.ev-tag-*` color variants. */
const EV_TAG_CLASS: Record<string, string> = {
  conversation_item_added: 'ev-tag-conv',
  speech_created: 'ev-tag-speech',
  agent_state_changed: 'ev-tag-agent',
  user_state_changed: 'ev-tag-user',
  user_input_transcribed: 'ev-tag-user',
  close: 'ev-tag-speech',
}

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

  if (!events || events.length === 0) {
    return (
      <div className="events-card">
        <div style={{ padding: 48, textAlign: 'center', color: 'hsl(var(--tertiary))', font: 'var(--text-s-400)' }}>
          No events captured for this session.
        </div>
      </div>
    )
  }

  const t0 = events[0].created_at
  const tEnd = events[events.length - 1].created_at
  const rangeLabel =
    timeMode === 'relative'
      ? `${formatRelative(0)} → ${formatRelative(tEnd - t0)}`
      : `${formatAbsolute(t0)} → ${formatAbsolute(tEnd)}`

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
          const relSec = event.created_at - t0
          const timeLabel = timeMode === 'relative' ? formatRelative(relSec) : formatAbsolute(event.created_at)
          const tagClass = EV_TAG_CLASS[event.type] ?? 'ev-tag-agent'
          return (
            <div key={i} className="ev-row">
              <div className="caret"><ChevronRight size={14} /></div>
              <div className="t">{timeLabel}</div>
              <div><span className={`tag ${tagClass}`}>{event.type}</span></div>
              <div className="msg"><EventMessage event={event} /></div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
