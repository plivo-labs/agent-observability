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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function compactJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value))
    } catch {
      return value
    }
  }
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function preview(value: unknown, max = 120): string {
  const text = compactJson(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function prettyJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  if (value == null) return '—'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function getConversationItem(event: SessionEvent): Record<string, unknown> | null {
  const e = event as Record<string, unknown>
  return event.type === 'conversation_item_added' ? asRecord(e.item) : null
}

function getFunctionCall(item: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!item) return null
  return item.type === 'function_call' ? item : asRecord(item.function_call)
}

function getFunctionCallOutput(item: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!item) return null
  return item.type === 'function_call_output' ? item : asRecord(item.function_call_output)
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <div className="text-xxs-600 uppercase tracking-[0.08em] text-[hsl(var(--tertiary))]">
        {label}
      </div>
      <div className="min-w-0 text-[13px] text-[hsl(var(--foreground))]">
        {children}
      </div>
    </div>
  )
}

function CodeBlock({ value }: { value: unknown }) {
  return (
    <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3 font-mono text-[12px] leading-relaxed text-[hsl(var(--secondary))]">
      {prettyJson(value)}
    </pre>
  )
}

function EventDetail({ event }: { event: SessionEvent }) {
  const item = getConversationItem(event)
  const functionCall = getFunctionCall(item)
  if (functionCall) {
    return (
      <div className="ev-detail">
        <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
          <span className="rounded border border-[hsl(var(--info-border))] bg-[hsl(var(--info-bg))] px-2 py-0.5 text-xxs-600 uppercase tracking-[0.08em] text-[hsl(var(--info))]">
            Tool call
          </span>
          <span className="truncate text-[14px] font-semibold text-[hsl(var(--foreground))]">
            {String(functionCall.name ?? 'unknown')}
          </span>
        </div>
        <div className="grid gap-3">
          {functionCall.call_id != null && (
            <DetailField label="Call ID">
              <code className="break-all rounded bg-[hsl(var(--bg2))] px-1.5 py-0.5 font-mono text-[12px]">
                {String(functionCall.call_id)}
              </code>
            </DetailField>
          )}
          <DetailField label="Arguments">
            <CodeBlock value={functionCall.arguments ?? {}} />
          </DetailField>
        </div>
      </div>
    )
  }

  const functionCallOutput = getFunctionCallOutput(item)
  if (functionCallOutput) {
    const output = functionCallOutput.output ?? functionCallOutput.result ?? functionCallOutput.error
    const isError = Boolean(functionCallOutput.is_error)
    return (
      <div className="ev-detail">
        <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
          <span className={`rounded border px-2 py-0.5 text-xxs-600 uppercase tracking-[0.08em] ${
            isError
              ? 'border-[hsl(var(--destructive-border))] bg-[hsl(var(--destructive-bg))] text-[hsl(var(--destructive))]'
              : 'border-[hsl(var(--success-border))] bg-[hsl(var(--success-bg))] text-[hsl(var(--success-fg,var(--success)))]'
          }`}>
            Tool result
          </span>
          <span className="truncate text-[14px] font-semibold text-[hsl(var(--foreground))]">
            {String(functionCallOutput.name ?? functionCallOutput.call_id ?? 'unknown')}
          </span>
        </div>
        <div className="grid gap-3">
          {functionCallOutput.call_id != null && (
            <DetailField label="Call ID">
              <code className="break-all rounded bg-[hsl(var(--bg2))] px-1.5 py-0.5 font-mono text-[12px]">
                {String(functionCallOutput.call_id)}
              </code>
            </DetailField>
          )}
          <DetailField label={isError ? 'Error' : 'Output'}>
            <CodeBlock value={output ?? '—'} />
          </DetailField>
        </div>
      </div>
    )
  }

  return (
    <pre className="ev-detail">
      {JSON.stringify(event, null, 2)}
    </pre>
  )
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
      const item = getConversationItem(event) ?? {}
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
      const functionCall = getFunctionCall(item)
      if (functionCall) {
        const args = preview(functionCall.arguments)
        return (
          <>
            tool call: <b>{String(functionCall.name ?? 'unknown')}</b>
            {args && <> <code>{args}</code></>}
          </>
        )
      }
      const functionCallOutput = getFunctionCallOutput(item)
      if (functionCallOutput) {
        return (
          <>
            tool result: <b>{String(functionCallOutput.name ?? functionCallOutput.call_id ?? 'unknown')}</b>
            {functionCallOutput.output != null && <> <q>{preview(functionCallOutput.output)}</q></>}
          </>
        )
      }
      const handoff = item.type === 'agent_handoff' ? item : asRecord(item.agent_handoff)
      if (handoff) {
        // LiveKit's SDK ships `new_agent_id` / `previous_agent_id` on
        // agent_handoff items. Older payloads (and the eval path) use
        // `from_agent` / `to_agent` / `old_agent` / `new_agent`. Accept any.
        const from = handoff.from_agent ?? handoff.previous_agent_id ?? handoff.old_agent_id ?? handoff.old_agent
        const to = handoff.to_agent ?? handoff.new_agent_id ?? handoff.new_agent
        // Drop the arrow entirely when one side is missing — the first
        // handoff in a session has no previous agent, so `handoff to: X`
        // reads more naturally than `— → X`.
        if (from != null && to != null) {
          return (
            <>
              handoff: <b>{String(from)}</b>
              <span className="arrow"> → </span>
              {String(to)}
            </>
          )
        }
        if (to != null) return <>handoff to: <b>{String(to)}</b></>
        if (from != null) return <>handoff from: <b>{String(from)}</b></>
        // Shouldn't happen — fall through to the generic item renderer.
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
                className={`ev-row${timeMode === 'absolute' ? ' absolute-time' : ''}`}
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
                    variant="outline"
                    data-event-type={event.type}
                    className={`tag h-5 rounded px-2 py-0 font-mono text-[10px] font-semibold tracking-[0.06em] ${tagTone}`}
                  >
                    <span>{event.type}</span>
                  </Badge>
                </div>
                <div className="msg"><EventMessage event={event} /></div>
              </div>
              {isOpen && (
                <EventDetail event={event} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
