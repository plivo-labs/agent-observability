import { ArrowRight, Wrench, User, Bot, FileCode2, HelpCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { RunEvent } from '@/lib/observability-types'

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
}: {
  role?: string
  content?: string
  interrupted?: boolean
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
            return <MessageBlock key={key} role={ev.role} content={ev.content} interrupted={ev.interrupted} />
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
