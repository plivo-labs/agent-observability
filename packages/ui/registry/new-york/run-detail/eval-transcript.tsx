/* eval-transcript.tsx — renders an eval case's `RunEvent[]` in the shared
 * Truman turn-bubble style. Message events are mapped to the shared
 * `Transcript`'s `TranscriptTurn` shape (role, text, latency-ms, interrupted
 * flag) and rendered with the shared <Transcript>; function_call /
 * function_call_output events are paired by call_id and rendered inline as
 * compact ▸-expandable tool rows so no detail is lost. Runs of consecutive
 * messages are batched into a single <Transcript> so the bubble layout reads
 * exactly like Simulate / Live. */
import { ChevronRight, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatToolValue } from '@/lib/observability-format'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Transcript, type TranscriptTurn } from '@/components/run-detail/transcript'
import type {
  RunEvent,
  RunEventFunctionCall,
  RunEventFunctionCallOutput,
  RunEventMessage,
} from '@/lib/observability-types'

/** Map a single `message` event → a shared `TranscriptTurn`.
 *  - role: a `user` message is the caller; everything else (assistant/system)
 *    is the agent under test.
 *  - ms: LiveKit ships `metrics.llm_node_ttft` in seconds → display ms (agent
 *    turns only; text sims have no metrics so this stays undefined).
 *  - flag: surface interruptions as the transcript's destructive flag. */
function messageToTurn(ev: RunEventMessage): TranscriptTurn {
  const role: TranscriptTurn['role'] = (ev.role ?? 'assistant') === 'user' ? 'user' : 'agent'
  let ms: number | null = null
  const ttft = ev.metrics?.llm_node_ttft
  if (role === 'agent' && typeof ttft === 'number' && Number.isFinite(ttft)) ms = Math.round(ttft * 1000)
  return {
    role,
    t: ev.content ?? '',
    ms,
    flag: ev.interrupted ? 'interrupted' : null,
  }
}

/** One row per logical tool invocation: a `function_call` collapses with its
 *  matching `function_call_output` (paired by call_id). Compact trigger shows
 *  the tool name; expanding reveals Input + Output. */
function ToolRow({
  call,
  output,
}: {
  call?: RunEventFunctionCall
  output?: RunEventFunctionCallOutput
}) {
  const argsStr = call ? formatToolValue(call.arguments) : ''
  const argsEmpty = argsStr.trim() === '' || argsStr.trim() === '{}' || argsStr.trim() === 'null'
  const outputStr = output ? formatToolValue(output.output) : ''
  const outputEmpty = outputStr.trim() === ''
  const headerLabel = call ? `${call.name ?? 'unknown'}` : 'tool result'
  return (
    <div className="ml-[3.125rem] mr-0">
      <Collapsible className="overflow-hidden rounded-lg border border-border bg-card shadow-[var(--ao-shadow-sm)]">
        <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 border-border bg-muted/60 px-3 py-1.5 text-[13px] font-semibold text-foreground hover:bg-muted data-[state=open]:border-b">
          <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <Wrench className="h-3 w-3 text-[var(--ao-accent)]" />
          <span className="font-mono">{headerLabel}</span>
          {output?.is_error && <span className="ao-badge is-danger" style={{ height: 18 }}>error</span>}
          <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-muted-foreground">tool call</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
          {call && (
            <>
              <div className="px-3 pt-2 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Input</div>
              {argsEmpty ? (
                <div className="px-3 pb-3 text-xs italic text-muted-foreground">No arguments recorded.</div>
              ) : (
                <pre className="overflow-x-auto whitespace-pre px-3 pb-3 font-mono text-xs text-foreground">{argsStr}</pre>
              )}
            </>
          )}
          {output && (
            <>
              <div className="px-3 pt-2 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Output</div>
              {outputEmpty ? (
                <div className="px-3 pb-3 text-sm italic text-muted-foreground">No output recorded.</div>
              ) : (
                <pre className="whitespace-pre-wrap break-words px-3 pb-3 font-mono text-sm text-foreground">{outputStr}</pre>
              )}
            </>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

/** Render the full event list: consecutive message events batch into a single
 *  shared <Transcript>; tool calls render inline between message batches. */
export function EvalTranscript({ events }: { events: RunEvent[] }) {
  if (events.length === 0) {
    return <div className="py-8 text-center text-sm text-muted-foreground">No events recorded.</div>
  }

  // Pre-pair function_call_output to its call_id so paired outputs aren't
  // rendered twice (orphan outputs still render on their own).
  const outputByCallId = new Map<string, RunEventFunctionCallOutput>()
  for (const ev of events) {
    if (ev.type === 'function_call_output') {
      const o = ev as RunEventFunctionCallOutput
      if (o.call_id) outputByCallId.set(o.call_id, o)
    }
  }
  const consumed = new Set<string>()

  const blocks: React.ReactNode[] = []
  let pending: TranscriptTurn[] = []
  let key = 0
  const flush = () => {
    if (pending.length) {
      blocks.push(<Transcript key={`msgs-${key++}`} turns={pending} />)
      pending = []
    }
  }

  for (const ev of events) {
    if (ev.type === 'message') {
      pending.push(messageToTurn(ev as RunEventMessage))
      continue
    }
    if (ev.type === 'function_call') {
      flush()
      const call = ev as RunEventFunctionCall
      const output = call.call_id ? outputByCallId.get(call.call_id) : undefined
      if (output && call.call_id) consumed.add(call.call_id)
      blocks.push(<ToolRow key={`tool-${key++}`} call={call} output={output} />)
      continue
    }
    if (ev.type === 'function_call_output') {
      const out = ev as RunEventFunctionCallOutput
      if (out.call_id && consumed.has(out.call_id)) continue
      flush()
      blocks.push(<ToolRow key={`tool-${key++}`} output={out} />)
      continue
    }
    // agent_handoff / unknown — compact meta row.
    flush()
    blocks.push(
      <div key={`ev-${key++}`} className={cn('ml-[3.125rem] rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-muted-foreground')}>
        {ev.type}
      </div>,
    )
  }
  flush()

  return <div className="flex flex-col gap-3">{blocks}</div>
}
