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
  avgTtfbMs: number | null
}

function computeCaseMetrics(events: RunEvent[]): MetricsSummary {
  const ttfts: number[] = []
  const ttfbs: number[] = []
  let turns = 0
  for (const ev of events) {
    if (ev.type !== 'message') continue
    const metrics = (ev as RunEventMessage).metrics
    if (!metrics) continue
    turns += 1
    const ttft = metrics.llm_node_ttft
    if (typeof ttft === 'number') ttfts.push(ttft * 1000)
    const ttfb = metrics.llm_node_ttfb
    if (typeof ttfb === 'number') ttfbs.push(ttfb * 1000)
  }
  return {
    turnsWithMetrics: turns,
    avgTtftMs: ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null,
    avgTtfbMs: ttfbs.length ? ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length : null,
  }
}

// ── Waterfall ────────────────────────────────────────────────────────────────

interface WaterfallItem {
  label: string
  kind: 'user' | 'assistant' | 'function_call' | 'function_call_output'
  durationMs: number
  offsetPct: number
  widthPct: number
}

const WATERFALL_COLORS: Record<WaterfallItem['kind'], string> = {
  user: 'hsl(var(--muted-foreground))',
  assistant: 'hsl(270 60% 55%)',
  function_call: 'hsl(38 80% 40%)',
  function_call_output: 'hsl(142 70% 28%)',
}

function buildWaterfallItems(events: RunEvent[]): WaterfallItem[] {
  // Each event gets an equal slot. Pull durations from metrics where available.
  const items: Array<{ label: string; kind: WaterfallItem['kind']; durationMs: number }> = []

  for (const ev of events) {
    if (ev.type === 'message') {
      const m = ev as RunEventMessage
      const metrics = m.metrics
      // Use ttft as a proxy for duration when available; fallback to 1 slot unit
      const ttft = metrics?.llm_node_ttft
      const durationMs = typeof ttft === 'number' ? ttft * 1000 : 200
      const kind: WaterfallItem['kind'] = m.role === 'user' ? 'user' : 'assistant'
      items.push({ label: m.role ?? 'assistant', kind, durationMs })
    } else if (ev.type === 'function_call') {
      const f = ev as RunEventFunctionCall
      items.push({ label: f.name ?? 'tool call', kind: 'function_call', durationMs: 200 })
    } else if (ev.type === 'function_call_output') {
      items.push({ label: 'tool result', kind: 'function_call_output', durationMs: 100 })
    }
  }

  if (items.length === 0) return []

  const total = items.reduce((s, it) => s + it.durationMs, 0)
  if (total === 0) return []

  const result: WaterfallItem[] = []
  let cumulative = 0
  for (const it of items) {
    result.push({
      ...it,
      offsetPct: (cumulative / total) * 100,
      widthPct: (it.durationMs / total) * 100,
    })
    cumulative += it.durationMs
  }
  return result
}

function WaterfallRow({ item }: { item: WaterfallItem }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '160px 1fr 60px',
        gap: 8,
        fontSize: 11,
        alignItems: 'center',
      }}
    >
      <span
        className="font-mono text-muted-foreground truncate"
        title={item.label}
      >
        {item.label}
      </span>
      <div className="h-[10px] bg-muted rounded-full relative">
        <div
          className="absolute h-full rounded-full"
          style={{
            left: `${item.offsetPct}%`,
            width: `${Math.max(item.widthPct, 1)}%`,
            backgroundColor: WATERFALL_COLORS[item.kind],
          }}
        />
      </div>
      <span className="text-right font-mono tabular-nums text-muted-foreground">
        {item.durationMs < 1000
          ? `${Math.round(item.durationMs)}ms`
          : `${(item.durationMs / 1000).toFixed(1)}s`}
      </span>
    </div>
  )
}

// ── Metrics grid ─────────────────────────────────────────────────────────────

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5 flex flex-col gap-0.5">
      <div className="text-xxs-600 text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className="font-mono text-s-600 text-foreground tabular-nums">{value}</div>
    </div>
  )
}

function formatTokens(tokens: number): string {
  return tokens > 0 ? tokens.toLocaleString() : '—'
}

function formatCost(cost: number | null): string {
  return cost == null ? '—' : `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`
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
      <Collapsible className="border rounded-md overflow-hidden">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-1.5 bg-muted text-foreground text-xs-600 cursor-pointer hover:bg-muted/80 data-[state=open]:border-b border-border">
          <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
          tool call · {f.name ?? 'unknown'}
          <span className="ml-auto text-xxs-400 font-mono tabular-nums">#{index}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {argsEmpty ? (
            <div className="p-3 text-xs-400 italic text-muted-foreground">
              No arguments recorded.
            </div>
          ) : (
            <pre className="p-3 text-xs-400 font-mono whitespace-pre overflow-x-auto">
              {argsStr}
            </pre>
          )}
        </CollapsibleContent>
      </Collapsible>
    )
  }
  if (event.type === 'function_call_output') {
    const o = event as RunEventFunctionCallOutput
    const out = o.output == null ? '' : String(o.output)
    const outEmpty = out.trim() === ''
    return (
      <Collapsible className="border rounded-md overflow-hidden">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-1.5 bg-muted text-foreground text-xs-600 cursor-pointer hover:bg-muted/80 data-[state=open]:border-b border-border">
          <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
          tool result
          {o.is_error && (
            <Badge variant="outline" className="text-xxs-600 text-foreground border-border">
              error
            </Badge>
          )}
          <span className="ml-auto text-xxs-400 font-mono tabular-nums">#{index}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {outEmpty ? (
            <div className="p-3 text-s-400 italic text-muted-foreground">
              No output recorded.
            </div>
          ) : (
            <div className="p-3 text-s-400 font-mono whitespace-pre-wrap break-words">
              {out}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
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
  const waterfallItems = useMemo(
    () => (evalCase ? buildWaterfallItems(evalCase.events) : []),
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
          {evalCase.total_tokens > 0 && (
            <>
              <span> · </span>
              <span>{formatTokens(evalCase.total_tokens)} tokens</span>
            </>
          )}
          {evalCase.estimated_cost_usd != null && (
            <>
              <span> · </span>
              <span>Est. cost {formatCost(evalCase.estimated_cost_usd)}</span>
            </>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetricTile
            label="TTFT (avg)"
            value={summary?.avgTtftMs != null ? formatMs(summary.avgTtftMs) : '—'}
          />
          <MetricTile
            label="TTFB (avg)"
            value={summary?.avgTtfbMs != null ? formatMs(summary.avgTtfbMs) : '—'}
          />
          <MetricTile
            label="Tokens"
            value={evalCase.total_tokens > 0 ? evalCase.total_tokens.toLocaleString() : '—'}
          />
          <MetricTile
            label="Est. cost"
            value={evalCase.estimated_cost_usd != null
              ? `$${evalCase.estimated_cost_usd.toFixed(evalCase.estimated_cost_usd < 0.01 ? 4 : 2)}`
              : '—'}
          />
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

        {waterfallItems.length > 0 && (
          <div>
            <div className="text-xxs-600 text-muted-foreground uppercase tracking-wider mb-2">
              Latency waterfall
            </div>
            <div className="flex flex-col gap-[6px]">
              {waterfallItems.map((item, i) => (
                <WaterfallRow key={i} item={item} />
              ))}
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
