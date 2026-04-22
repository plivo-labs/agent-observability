import { ArrowRight, Wrench, User, Bot, FileCode2, HelpCircle, Gauge } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { formatMs } from '@/lib/observability-format'
import type { RunEvent } from '@/lib/observability-types'

type Metrics = Record<string, number | string | null> | null | undefined

/**
 * Render per-turn metrics as small chips next to a message. Keys like
 * `*_at` are timestamps and rendered as durations relative to the earliest
 * timestamp in the metrics dict (the "speaking-for" window). Keys ending in
 * `_ttft` / `_duration` are durations in seconds — format as ms. Other
 * numeric keys pass through with a best-effort label.
 */
function MetricsChips({ metrics }: { metrics: Metrics }) {
  if (!metrics || typeof metrics !== 'object') return null

  const chips: Array<{ label: string; value: string }> = []

  // Derive speaking duration from the two timestamp bookends if both present.
  const start = metrics.started_speaking_at
  const stop = metrics.stopped_speaking_at
  if (typeof start === 'number' && typeof stop === 'number' && stop >= start) {
    chips.push({ label: 'spoke', value: formatMs((stop - start) * 1000) })
  }

  for (const [key, value] of Object.entries(metrics)) {
    if (key === 'started_speaking_at' || key === 'stopped_speaking_at') continue
    if (value == null) continue
    if (typeof value !== 'number') continue

    if (key.endsWith('_ttft')) {
      chips.push({ label: 'TTFT', value: formatMs(value * 1000) })
    } else if (key.endsWith('_ttfb')) {
      chips.push({ label: 'TTFB', value: formatMs(value * 1000) })
    } else if (key.endsWith('_duration_ms')) {
      chips.push({ label: prettyKey(key.replace(/_duration_ms$/, '')), value: formatMs(value) })
    } else if (key.endsWith('_duration')) {
      chips.push({ label: prettyKey(key.replace(/_duration$/, '')), value: formatMs(value * 1000) })
    } else if (key.endsWith('_at')) {
      // Remaining absolute timestamps aren't useful as inline chips.
      continue
    } else if (key.endsWith('_tokens') || key === 'total_tokens') {
      chips.push({ label: prettyKey(key), value: String(value) })
    } else {
      chips.push({ label: prettyKey(key), value: String(value) })
    }
  }

  if (chips.length === 0) return null

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <Gauge className="h-3 w-3 text-muted-foreground" />
      {chips.map((c) => (
        <span
          key={`${c.label}-${c.value}`}
          className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xxs-400 text-muted-foreground font-mono"
        >
          <span className="uppercase tracking-wide">{c.label}</span>
          <span className="text-foreground">{c.value}</span>
        </span>
      ))}
    </div>
  )
}

function prettyKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\bllm\b|\bstt\b|\btts\b/gi, (s) => s.toUpperCase())
}

function FunctionCallBlock({
  name,
  args,
}: {
  name?: string
  args?: unknown
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-s-500 font-mono font-medium">{name ?? '(unnamed)'}</span>
      </div>
      <pre className="mt-2 text-xs-400 font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap">
        {args == null ? '{}' : JSON.stringify(args, null, 2)}
      </pre>
    </div>
  )
}

function FunctionOutputBlock({
  output,
  isError,
}: {
  output?: string
  isError?: boolean
}) {
  return (
    <div
      className={`rounded-md border p-3 ${
        isError
          ? 'bg-destructive/10 border-destructive/40'
          : 'bg-emerald-500/10 border-emerald-500/30'
      }`}
    >
      <div className="flex items-center gap-2">
        <FileCode2 className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs-500 uppercase tracking-wide text-muted-foreground">
          {isError ? 'Tool error' : 'Tool output'}
        </span>
      </div>
      <pre className="mt-1 text-s-400 font-mono whitespace-pre-wrap">{output ?? ''}</pre>
    </div>
  )
}

function MessageBlock({
  role,
  content,
  interrupted,
  metrics,
}: {
  role?: string
  content?: string
  interrupted?: boolean
  metrics?: Metrics
}) {
  const isAssistant = role === 'assistant'
  const Icon = isAssistant ? Bot : User
  return (
    <div className={`rounded-md border p-3 ${isAssistant ? 'bg-card' : 'bg-muted/30'}`}>
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs-500 uppercase tracking-wide text-muted-foreground">
          {role ?? 'message'}
        </span>
        {interrupted && (
          <Badge variant="outline" className="text-xxs-400">
            interrupted
          </Badge>
        )}
      </div>
      <p className="mt-1 text-s-400 whitespace-pre-wrap">{content ?? ''}</p>
      <MetricsChips metrics={metrics} />
    </div>
  )
}

function HandoffBlock({
  from,
  to,
}: {
  from?: string
  to?: string
}) {
  return (
    <div className="rounded-md border border-dashed bg-accent/30 p-3 flex items-center gap-2 text-s-400">
      <span className="font-mono">{from ?? '?'}</span>
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="font-mono">{to ?? '?'}</span>
      <Badge variant="outline" className="text-xxs-400 ml-auto">
        agent handoff
      </Badge>
    </div>
  )
}

function UnknownEventBlock({ event }: { event: Record<string, unknown> }) {
  const { type, ...rest } = event
  return (
    <div className="rounded-md border border-dashed bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs-500 uppercase tracking-wide text-muted-foreground">
          {typeof type === 'string' ? type : 'event'}
        </span>
        <Badge variant="outline" className="text-xxs-400 ml-auto">
          unknown
        </Badge>
      </div>
      <pre className="mt-2 text-xs-400 font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap">
        {JSON.stringify(rest, null, 2)}
      </pre>
    </div>
  )
}

export function EvalEventTimeline({ events }: { events: RunEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-md border bg-muted/20 p-6 text-center text-muted-foreground text-s-400">
        No events captured for this case.
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {events.map((ev, i) => {
        const key = `${ev.type}-${i}`
        switch (ev.type) {
          case 'message':
            return (
              <MessageBlock
                key={key}
                role={ev.role}
                content={ev.content}
                interrupted={ev.interrupted}
                metrics={ev.metrics}
              />
            )
          case 'function_call':
            return <FunctionCallBlock key={key} name={ev.name} args={ev.arguments} />
          case 'function_call_output':
            return <FunctionOutputBlock key={key} output={ev.output} isError={ev.is_error} />
          case 'agent_handoff':
            return <HandoffBlock key={key} from={ev.from_agent} to={ev.to_agent} />
          default:
            return (
              <UnknownEventBlock
                key={key}
                event={ev as unknown as Record<string, unknown>}
              />
            )
        }
      })}
    </div>
  )
}
