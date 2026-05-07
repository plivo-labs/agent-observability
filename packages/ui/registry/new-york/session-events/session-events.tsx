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
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="min-w-0 text-[13px] text-foreground">
        {children}
      </div>
    </div>
  )
}

function CodeBlock({ value }: { value: unknown }) {
  return (
    <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-card p-3 font-mono text-[12px] leading-relaxed text-muted-foreground">
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
          <span className="rounded border border-[hsl(var(--info-border))] bg-[hsl(var(--info-bg))] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[hsl(var(--info))]">
            Tool call
          </span>
          <span className="truncate text-[14px] font-semibold text-foreground">
            {String(functionCall.name ?? 'unknown')}
          </span>
        </div>
        <div className="grid gap-3">
          {functionCall.call_id != null && (
            <DetailField label="Call ID">
              <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">
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
          <span className={cn(
            'rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
            isError
              ? 'border-[hsl(var(--destructive-border))] bg-[hsl(var(--destructive-bg))] text-destructive'
              : 'border-[hsl(var(--success-border))] bg-[hsl(var(--success-bg))] text-[hsl(var(--success-fg,var(--success)))]',
          )}>
            Tool result
          </span>
          <span className="truncate text-[14px] font-semibold text-foreground">
            {String(functionCallOutput.name ?? functionCallOutput.call_id ?? 'unknown')}
          </span>
        </div>
        <div className="grid gap-3">
          {functionCallOutput.call_id != null && (
            <DetailField label="Call ID">
              <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">
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
      const item = getConversationItem(event) ?? {}
      if (item.type === 'message') {
        const content = Array.isArray(item.content)
          ? item.content.join(' ')
          : item.content ?? ''
        const preview = String(content).slice(0, 120)
        const ellipsis = String(content).length > 120 ? '…' : ''
        return `${item.role}: "${preview}${ellipsis}"`
      }
      const functionCall = getFunctionCall(item)
      if (functionCall) {
        const args = preview(functionCall.arguments)
        return `tool call: ${functionCall.name ?? 'unknown'}${args ? ` ${args}` : ''}`
      }
      const functionCallOutput = getFunctionCallOutput(item)
      if (functionCallOutput) {
        const output = preview(functionCallOutput.output)
        return `tool result: ${functionCallOutput.name ?? functionCallOutput.call_id ?? 'unknown'}${output ? ` "${output}"` : ''}`
      }
      const handoff = item.type === 'agent_handoff' ? item : asRecord(item.agent_handoff)
      if (handoff) {
        // LiveKit's SDK ships `new_agent_id` / `previous_agent_id` on
        // agent_handoff items. Older payloads (and the eval path) use
        // `from_agent` / `to_agent` / `old_agent` / `new_agent`. Accept any.
        const from = handoff.from_agent ?? handoff.previous_agent_id ?? handoff.old_agent_id ?? handoff.old_agent
        const to = handoff.to_agent ?? handoff.new_agent_id ?? handoff.new_agent
        // Drop the arrow when one side is missing — the first handoff in a
        // session has no previous agent, so `handoff to: X` reads more
        // naturally than `— → X`.
        if (from != null && to != null) return `handoff: ${from} → ${to}`
        if (to != null) return `handoff to: ${to}`
        if (from != null) return `handoff from: ${from}`
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
        <EventDetail event={event} />
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
