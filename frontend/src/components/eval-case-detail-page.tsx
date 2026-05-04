import { useMemo } from 'react'
import { AlertTriangle, ArrowLeft, ChevronRight, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { formatDuration, formatMs, formatToolValue } from '@/lib/observability-format'
import { useEvalCase } from '@/lib/observability-hooks'
import type {
  CaseStatus,
  RunEvent,
  RunEventFunctionCall,
  RunEventFunctionCallOutput,
  RunEventMessage,
} from '@/lib/observability-types'

interface MetricsSummary {
  turnsWithMetrics: number
  avgTtftMs: number | null
}

function computeCaseMetrics(events: RunEvent[]): MetricsSummary {
  const ttfts: number[] = []
  let turns = 0
  for (const ev of events) {
    if (ev.type !== 'message') continue
    const metrics = (ev as RunEventMessage).metrics
    if (!metrics) continue
    turns += 1
    const ttft = metrics.llm_node_ttft
    if (typeof ttft === 'number') ttfts.push(ttft * 1000)
  }
  return {
    turnsWithMetrics: turns,
    avgTtftMs: ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null,
  }
}

const STATUS_TONE: Record<CaseStatus, string> = {
  passed:
    'bg-[hsl(var(--success-bg))] text-[hsl(var(--success-fg,var(--success)))] border-[hsl(var(--success-border))]',
  failed:
    'bg-[hsl(var(--destructive-bg))] text-[hsl(var(--destructive))] border-[hsl(var(--destructive-border))]',
  errored:
    'bg-[hsl(var(--warning-bg))] text-[hsl(var(--warning-fg,var(--warning)))] border-[hsl(var(--warning-border))]',
  skipped: 'bg-muted text-muted-foreground border-border',
}

function StatusChip({ status }: { status: CaseStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center h-[22px] px-2 rounded-full border text-xxs-600 capitalize',
        STATUS_TONE[status],
      )}
    >
      {status}
    </span>
  )
}

function MessageRow({ event, index }: { event: RunEventMessage; index: number }) {
  return (
    <div className="border rounded-md overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted text-xs-600 text-muted-foreground border-b">
        <span className="inline-flex items-center px-1.5 py-0 rounded bg-muted text-foreground border border-border text-xxs-600 capitalize">
          {event.role ?? 'assistant'}
        </span>
        {event.interrupted && (
          <Badge variant="outline" className="text-xxs-600 text-foreground border-border">
            interrupted
          </Badge>
        )}
        <span className="ml-auto text-xxs-400 font-mono tabular-nums">#{index}</span>
      </div>
      <div className="p-3 text-s-400 whitespace-pre-wrap">{event.content ?? ''}</div>
    </div>
  )
}

// One row per logical tool invocation. A `function_call` and its matching
// `function_call_output` (paired by `call_id` upstream) collapse into a single
// accordion: the trigger shows just the tool name, and expanding reveals
// Input + Output sections. An orphan output (no preceding call) renders with
// only the Output section visible.
function ToolInvocationRow({
  call,
  output,
  index,
}: {
  call?: RunEventFunctionCall
  output?: RunEventFunctionCallOutput
  index: number
}) {
  const argsStr = call ? formatToolValue(call.arguments) : ''
  const argsEmpty = argsStr.trim() === '' || argsStr.trim() === '{}' || argsStr.trim() === 'null'
  const outputStr = output ? formatToolValue(output.output) : ''
  const outputEmpty = outputStr.trim() === ''
  const headerLabel = call ? `tool call · ${call.name ?? 'unknown'}` : 'tool result'

  return (
    <Collapsible className="border rounded-md overflow-hidden">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-1.5 bg-muted text-foreground text-xs-600 cursor-pointer hover:bg-muted/80 data-[state=open]:border-b border-border">
        <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
        {headerLabel}
        {output?.is_error && (
          <Badge variant="outline" className="text-xxs-600 text-foreground border-border">
            error
          </Badge>
        )}
        <span className="ml-auto text-xxs-400 font-mono tabular-nums">#{index}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {call && (
          <>
            <div className="px-3 pt-2 pb-1 text-xxs-600 text-muted-foreground uppercase tracking-wider">
              Input
            </div>
            {argsEmpty ? (
              <div className="px-3 pb-3 text-xs-400 italic text-muted-foreground">
                No arguments recorded.
              </div>
            ) : (
              <pre className="px-3 pb-3 text-xs-400 font-mono whitespace-pre overflow-x-auto">
                {argsStr}
              </pre>
            )}
          </>
        )}
        {output && (
          <>
            <div className="px-3 pt-2 pb-1 text-xxs-600 text-muted-foreground uppercase tracking-wider">
              Output
            </div>
            {outputEmpty ? (
              <div className="px-3 pb-3 text-s-400 italic text-muted-foreground">
                No output recorded.
              </div>
            ) : (
              <pre className="px-3 pb-3 text-s-400 font-mono whitespace-pre-wrap break-words">
                {outputStr}
              </pre>
            )}
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

// Walks the event list and pairs each `function_call` with its matching
// `function_call_output` by `call_id`, emitting one ToolInvocationRow per
// pair. Outputs without a preceding call render as orphans. Messages and
// unknown event types render through their own components.
function renderTranscript(events: RunEvent[]): React.ReactNode {
  const outputByCallId = new Map<string, RunEventFunctionCallOutput>()
  for (const ev of events) {
    if (ev.type === 'function_call_output') {
      const o = ev as RunEventFunctionCallOutput
      if (o.call_id) outputByCallId.set(o.call_id, o)
    }
  }

  const consumed = new Set<string>()
  return events.map((ev, i) => {
    if (ev.type === 'message') {
      return <MessageRow key={i} event={ev as RunEventMessage} index={i} />
    }
    if (ev.type === 'function_call') {
      const call = ev as RunEventFunctionCall
      const output = call.call_id ? outputByCallId.get(call.call_id) : undefined
      if (output && call.call_id) consumed.add(call.call_id)
      return <ToolInvocationRow key={i} call={call} output={output} index={i} />
    }
    if (ev.type === 'function_call_output') {
      const out = ev as RunEventFunctionCallOutput
      if (out.call_id && consumed.has(out.call_id)) return null
      return <ToolInvocationRow key={i} output={out} index={i} />
    }
    return (
      <div
        key={i}
        className="border rounded-md px-3 py-2 text-xs-400 text-muted-foreground"
      >
        {ev.type}
      </div>
    )
  })
}

export const EvalCaseDetailPage = ({
  runId,
  caseId,
  onBack,
}: {
  runId: string
  caseId: string
  onBack?: () => void
}) => {
  const { evalCase, loading, error } = useEvalCase(runId, caseId)
  const summary = useMemo(
    () => (evalCase ? computeCaseMetrics(evalCase.events) : null),
    [evalCase],
  )

  if (loading) {
    return (
      <div className="flex flex-col gap-3.5 p-[18px_22px]" aria-busy="true">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-64" />
        <div className="grid grid-cols-3 gap-1.5">
          <Skeleton className="h-[56px]" />
          <Skeleton className="h-[56px]" />
          <Skeleton className="h-[56px]" />
        </div>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (error || !evalCase) {
    return (
      <div className="p-12 text-center text-foreground">
        <p>Failed to load case: {error ?? 'not found'}</p>
      </div>
    )
  }

  return (
    <>
      <div className="flex items-center justify-between px-[18px] py-3.5 border-b text-s-500 text-muted-foreground">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="h-auto p-0 text-s-500 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> Back to run
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={onBack}
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="px-[22px] py-[18px] pb-[30px] flex flex-col gap-4">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="font-mono text-h4-600">{evalCase.name}</span>
          <StatusChip status={evalCase.status} />
        </div>
        <div className="font-mono text-xs-400 text-muted-foreground -mt-2">
          {evalCase.file && <span>{evalCase.file}</span>}
          {evalCase.file && <span> · </span>}
          <span>{formatDuration(evalCase.duration_ms)}</span>
          {evalCase.events.length > 0 && (
            <>
              <span> · </span>
              <span>
                {evalCase.events.length} event{evalCase.events.length !== 1 ? 's' : ''}
              </span>
            </>
          )}
          {evalCase.judgments.length > 0 && (
            <>
              <span> · </span>
              <span>
                {evalCase.judgments.length} judgment
                {evalCase.judgments.length !== 1 ? 's' : ''}
              </span>
            </>
          )}
          {summary?.avgTtftMs != null && (
            <>
              <span> · </span>
              <span>Avg TTFT {formatMs(summary.avgTtftMs)}</span>
            </>
          )}
        </div>

        {evalCase.user_input && (
          <div>
            <div className="text-xxs-600 text-muted-foreground uppercase tracking-wider mb-2">
              User input
            </div>
            <div className="border border-l-4 border-l-muted-foreground rounded-md bg-muted/50 px-3 py-2.5 text-s-400">
              {evalCase.user_input}
            </div>
          </div>
        )}

        <div>
          <div className="text-xxs-600 text-muted-foreground uppercase tracking-wider mb-2">
            Transcript
          </div>
          <div className="flex flex-col gap-2.5">
            {renderTranscript(evalCase.events)}
          </div>
        </div>

        {evalCase.judgments.length > 0 && (
          <div>
            <div className="text-xxs-600 text-muted-foreground uppercase tracking-wider mb-2">
              Judgments
            </div>
            <div className="flex flex-col gap-2">
              {evalCase.judgments.map((j, i) => {
                const tone =
                  j.verdict === 'pass'
                    ? 'pass'
                    : j.verdict === 'fail'
                      ? 'fail'
                      : 'other'
                return (
                  <div
                    key={`${j.intent}-${i}`}
                    className={cn(
                      'rounded-md border px-3 py-2.5',
                      tone === 'pass' &&
                        'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/30',
                      tone === 'fail' &&
                        'border-rose-200 bg-rose-50/60 dark:border-rose-900/40 dark:bg-rose-950/30',
                      tone === 'other' && 'border-border bg-muted/40',
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-s-500 m-0">{j.intent}</p>
                      <span
                        className={cn(
                          'inline-flex items-center h-[22px] px-2 rounded-full border text-xxs-600 capitalize',
                          tone === 'pass' &&
                            'border-emerald-300 bg-emerald-100 text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/50 dark:text-emerald-200',
                          tone === 'fail' &&
                            'border-rose-300 bg-rose-100 text-rose-900 dark:border-rose-800/60 dark:bg-rose-950/50 dark:text-rose-200',
                          tone === 'other' &&
                            'border-border bg-muted text-muted-foreground',
                        )}
                      >
                        {tone === 'pass' ? 'passed' : tone === 'fail' ? 'failed' : 'errored'}
                      </span>
                    </div>
                    {j.reasoning && (
                      <p className="mt-2 text-s-400 text-muted-foreground whitespace-pre-wrap">
                        {j.reasoning}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {evalCase.failure && (
          <Card className="border-border bg-muted/40">
            <CardContent className="py-3">
              <div className="flex items-center gap-2 text-s-600 text-foreground mb-2">
                <AlertTriangle className="h-3.5 w-3.5" /> Failure ({evalCase.failure.kind})
              </div>
              {evalCase.failure.message && (
                <div className="text-s-500 mb-2">{evalCase.failure.message}</div>
              )}
              {evalCase.failure.stack && (
                <Collapsible>
                  <CollapsibleTrigger className="text-xs-600 text-muted-foreground uppercase tracking-wider hover:text-foreground cursor-pointer bg-transparent border-none p-0">
                    Stack trace
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-2">
                    <pre className="border rounded-md bg-card px-2.5 py-2 font-mono text-xs-400 text-muted-foreground whitespace-pre-wrap break-words max-h-[180px] overflow-auto">
                      {evalCase.failure.stack}
                    </pre>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  )
}
