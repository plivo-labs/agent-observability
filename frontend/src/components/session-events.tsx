import { useState } from 'react'
import { ChevronDown, Clock } from 'lucide-react'
import dayjs from 'dayjs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { useEvents } from '@/lib/observability-hooks'
import type { SessionEvent } from '@/lib/observability-types'

// All light/tinted so badges stay readable in both themes — overrides the
// default Badge variant background via tailwind-merge.
// Consumers can override per-type classes by passing `typeBadgeClass` to
// <SessionEvents /> or by targeting `[data-event-type="..."]` in CSS.
export const DEFAULT_TYPE_BADGE_CLASS: Record<string, string> = {
  agent_state_changed:
    'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-200',
  user_state_changed:
    'bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-200',
  user_input_transcribed:
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
  conversation_item_added:
    'bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200',
  speech_created:
    'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  close:
    'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200',
}

const FALLBACK_BADGE_CLASS = 'bg-muted text-muted-foreground'

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
  timeMode,
  badgeClass,
}: {
  event: SessionEvent
  relSeconds: number
  timeMode: TimeMode
  badgeClass: string
}) => {
  const timeLabel =
    timeMode === 'relative'
      ? formatRelative(relSeconds)
      : formatAbsolute(event.created_at)
  return (
    <Collapsible className="group/event border-b last:border-b-0">
      <CollapsibleTrigger className="flex w-full items-start gap-3 px-3 py-2 text-left text-sm cursor-pointer hover:bg-muted/40 transition-colors data-[state=open]:bg-muted/30">
        <ChevronDown
          size={13}
          className="mt-0.5 text-muted-foreground transition-transform group-data-[state=open]/event:rotate-0 -rotate-90"
        />
        <span
          className={cn(
            'font-mono text-xs text-muted-foreground shrink-0 pt-0.5 tabular-nums',
            timeMode === 'relative' ? 'w-16' : 'w-24',
          )}
        >
          {timeLabel}
        </span>
        <Badge
          data-event-type={event.type}
          className={cn('shrink-0 border-transparent', badgeClass)}
        >
          {event.type}
        </Badge>
        <span className="flex-1 truncate text-muted-foreground">
          {summarize(event)}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-none data-[state=open]:animate-none">
        <pre
          className={cn(
            'overflow-auto bg-muted/20 px-3 pb-3 text-xs leading-relaxed',
            timeMode === 'relative' ? 'pl-[76px]' : 'pl-[108px]',
          )}
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
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No events captured for this session.
        </CardContent>
      </Card>
    )
  }

  const t0 = events[0].created_at
  const tEnd = events[events.length - 1].created_at

  const rangeLabel =
    timeMode === 'relative'
      ? `${formatRelative(0)} → ${formatRelative(tEnd - t0)}`
      : `${formatAbsolute(t0)} → ${formatAbsolute(tEnd)}`

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-3">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <div className="flex items-center gap-3">
            <span>{events.length} events</span>
            <span className="font-mono text-xs text-muted-foreground">
              {rangeLabel}
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setTimeMode((m) => (m === 'relative' ? 'absolute' : 'relative'))
            }
            className="gap-1.5 text-xs"
          >
            <Clock size={12} />
            {timeMode === 'relative' ? 'Relative' : 'Absolute'}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ul>
          {events.map((event, i) => (
            <EventRow
              key={i}
              event={event}
              relSeconds={event.created_at - t0}
              timeMode={timeMode}
              badgeClass={badgeClassFor(event.type)}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
