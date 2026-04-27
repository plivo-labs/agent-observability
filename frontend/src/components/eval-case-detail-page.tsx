import { useMemo } from 'react'
import { AlertTriangle, ArrowLeft, AudioWaveform, Clock, Repeat, X } from 'lucide-react'
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
import { formatDuration, formatMs } from '@/lib/observability-format'
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
  totalSpeakingMs: number | null
}

function computeCaseMetrics(events: RunEvent[]): MetricsSummary {
  const ttfts: number[] = []
  let speakingMs = 0
  let turns = 0
  for (const ev of events) {
    if (ev.type !== 'message') continue
    const metrics = (ev as RunEventMessage).metrics
    if (!metrics) continue
    turns += 1
    const ttft = metrics.llm_node_ttft
    if (typeof ttft === 'number') ttfts.push(ttft * 1000)
    const start = metrics.started_speaking_at
    const stop = metrics.stopped_speaking_at
    if (typeof start === 'number' && typeof stop === 'number' && stop >= start) {
      speakingMs += (stop - start) * 1000
    }
  }
  return {
    turnsWithMetrics: turns,
    avgTtftMs: ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null,
    totalSpeakingMs: speakingMs > 0 ? speakingMs : null,
  }
}

const STATUS_TONE: Record<CaseStatus, string> = {
  passed:
    'bg-muted text-foreground border-border',
  failed:
    'bg-muted text-foreground border-border',
  errored:
    'bg-muted text-foreground border-border',
  skipped: 'bg-muted text-muted-foreground border',
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

function StatTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="rounded-md bg-card p-2.5">
      <div className="flex items-center gap-1.5 text-xxs-600 text-muted-foreground uppercase tracking-wider mb-1">
        {icon} {label}
      </div>
      <div className="font-mono text-p-600 tabular-nums">{value}</div>
    </div>
  )
}

function EventRow({ event, index }: { event: RunEvent; index: number }) {
  if (event.type === 'message') {
    const m = event as RunEventMessage
    return (
      <div className="border rounded-md overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-muted text-xs-600 text-muted-foreground border-b">
          <span className="inline-flex items-center px-1.5 py-0 rounded bg-muted text-foreground border border-border text-xxs-600 capitalize">
            {m.role ?? 'assistant'}
          </span>
          {m.interrupted && (
            <Badge variant="outline" className="text-xxs-600 text-foreground border-border">
              interrupted
            </Badge>
          )}
          <span className="ml-auto text-xxs-400 font-mono tabular-nums">#{index}</span>
        </div>
        <div className="p-3 text-s-400 whitespace-pre-wrap">{m.content ?? ''}</div>
      </div>
    )
  }
  if (event.type === 'function_call') {
    const f = event as RunEventFunctionCall
    const argsStr =
      typeof f.arguments === 'string'
        ? f.arguments
        : f.arguments == null
          ? ''
          : JSON.stringify(f.arguments, null, 2)
    // Treat empty string / `{}` / `null` / `undefined` as "no arguments"
    // rather than leaving the <pre> blank.
    const argsEmpty = argsStr.trim() === '' || argsStr.trim() === '{}' || argsStr.trim() === 'null'
    return (
      <div className="border rounded-md overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-muted text-foreground border-b border-border text-xs-600">
          tool call · {f.name ?? 'unknown'}
          <span className="ml-auto text-xxs-400 font-mono tabular-nums">#{index}</span>
        </div>
        {argsEmpty ? (
          <div className="p-3 text-xs-400 italic text-muted-foreground">
            No arguments recorded.
          </div>
        ) : (
          <pre className="p-3 text-xs-400 font-mono whitespace-pre overflow-x-auto">
            {argsStr}
          </pre>
        )}
      </div>
    )
  }
  if (event.type === 'function_call_output') {
    const o = event as RunEventFunctionCallOutput
    const out = o.output == null ? '' : String(o.output)
    const outEmpty = out.trim() === ''
    return (
      <div className="border rounded-md overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-muted text-foreground border-b border-border text-xs-600">
          tool result
          {o.is_error && (
            <Badge variant="outline" className="text-xxs-600 text-foreground border-border">
              error
            </Badge>
          )}
          <span className="ml-auto text-xxs-400 font-mono tabular-nums">#{index}</span>
        </div>
        {outEmpty ? (
          <div className="p-3 text-s-400 italic text-muted-foreground">
            No output recorded.
          </div>
        ) : (
          <div className="p-3 text-s-400 font-mono whitespace-pre-wrap break-words">
            {out}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="border rounded-md px-3 py-2 text-xs-400 text-muted-foreground">
      {event.type}
    </div>
  )
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
        </div>

        {summary && summary.turnsWithMetrics > 0 && (
          <div className="grid grid-cols-3 gap-0.5 bg-muted border rounded-lg p-0.5">
            <StatTile
              icon={<Clock className="h-2.5 w-2.5" />}
              label="Avg TTFT"
              value={summary.avgTtftMs != null ? formatMs(summary.avgTtftMs) : '—'}
            />
            <StatTile
              icon={<AudioWaveform className="h-2.5 w-2.5" />}
              label="Agent spoke"
              value={summary.totalSpeakingMs != null ? formatMs(summary.totalSpeakingMs) : '—'}
            />
            <StatTile
              icon={<Repeat className="h-2.5 w-2.5" />}
              label="Turns w/ metrics"
              value={String(summary.turnsWithMetrics)}
            />
          </div>
        )}

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
            {evalCase.events.map((ev, i) => (
              <EventRow key={i} event={ev} index={i} />
            ))}
          </div>
        </div>

        {evalCase.judgments.length > 0 && (
          <div>
            <div className="text-xxs-600 text-muted-foreground uppercase tracking-wider mb-2">
              Judgments
            </div>
            <div className="flex flex-col gap-2">
              {evalCase.judgments.map((j, i) => {
                const isFail = j.verdict === 'fail'
                return (
                  <div
                    key={`${j.intent}-${i}`}
                    className={cn(
                      'rounded-md px-3 py-2.5',
                      isFail
                        ? 'border border-border bg-muted/50'
                        : 'border',
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-s-500 m-0">{j.intent}</p>
                      <StatusChip
                        status={
                          j.verdict === 'pass'
                            ? 'passed'
                            : j.verdict === 'fail'
                              ? 'failed'
                              : 'errored'
                        }
                      />
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
