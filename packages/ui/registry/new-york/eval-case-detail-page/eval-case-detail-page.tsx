import { useMemo } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  AudioLines,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock,
  Cpu,
  Gauge,
  Hash,
  MessageSquareText,
  ScrollText,
  Wrench,
  X,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { formatDuration, formatMs, formatToolValue } from '@/lib/observability-format'
import { useEvalCase } from '@/lib/observability-hooks'
import type {
  JudgmentVerdict,
  RunEvent,
  RunEventFunctionCall,
  RunEventFunctionCallOutput,
  RunEventMessage,
} from '@/lib/observability-types'
import { StatusBadge, STATUS_LABEL } from '@/components/run-detail/status-badge'

interface MetricsSummary {
  turnsWithMetrics: number
  avgTtftMs: number | null
  models: string[]
}

// LiveKit ships per-turn metrics on each message event (in seconds). Eval
// runs today only populate `llm_node_ttft` — TTFB / E2E / transcription
// require an audio pipeline (STT/TTS) which `AgentSession.run(user_input=…)`
// runs in text-only mode never wires up. The per-turn chip strip in
// `MessageRow` still auto-discovers any timing key via the suffix regex,
// so if a future eval ships those keys they'll surface there without
// touching this aggregate.
function computeCaseMetrics(events: RunEvent[]): MetricsSummary {
  const ttfts: number[] = []
  const models = new Set<string>()
  let turns = 0
  for (const ev of events) {
    if (ev.type !== 'message') continue
    const metrics = (ev as RunEventMessage).metrics
    if (!metrics) continue
    turns += 1
    const ttft = metrics.llm_node_ttft
    if (typeof ttft === 'number') ttfts.push(ttft * 1000)
    const meta = metrics.llm_metadata
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const name = (meta as Record<string, unknown>).model_name
      if (typeof name === 'string' && name) models.add(name)
    }
  }
  return {
    turnsWithMetrics: turns,
    avgTtftMs: ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null,
    models: [...models],
  }
}

// Friendly labels for the per-turn metric keys LiveKit ships. Anything not
// listed here falls back to a generic title-cased rendering of the snake_case
// key — so a future SDK metric shows up automatically without code changes.
const TIMING_LABELS: Record<string, string> = {
  llm_node_ttft: 'TTFT',
  llm_node_ttfb: 'LLM TTFB',
  tts_node_ttfb: 'TTS TTFB',
  e2e_latency: 'E2E',
  transcription_delay: 'Transcription',
  endpointing_delay: 'Endpointing',
  eou_delay: 'EOU',
  playback_latency: 'Playback',
}
const TOKEN_LABELS: Record<string, string> = {
  prompt_tokens: 'Prompt',
  completion_tokens: 'Completion',
  total_tokens: 'Total',
  cached_tokens: 'Cached',
}
const TIMING_KEY_PATTERN = /(_ttft|_ttfb|_delay|_latency)$/
// Unix-second timestamps add no value as raw numbers next to a turn — skip.
const TIMESTAMP_KEYS = new Set(['started_speaking_at', 'stopped_speaking_at', 'created_at'])
// Low-signal metric keys we deliberately hide. `playback_latency` is almost
// always 0 in eval runs (no audio pipeline); `model_provider` duplicates
// info the model name already implies.
const HIDDEN_TURN_METRIC_KEYS = new Set(['playback_latency'])

function humanize(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

interface MetricChip {
  key: string
  label: string
  value: string
}

// Flatten the per-turn `metrics` dict into display chips. Top-level numeric
// timings (seconds) become formatted ms; `llm_metadata` is expanded into
// model + token chips. Unknown numeric keys still render generically so we
// don't silently swallow new SDK fields.
function buildMetricChips(metrics: Record<string, unknown>): MetricChip[] {
  const chips: MetricChip[] = []

  for (const [k, v] of Object.entries(metrics)) {
    if (k === 'llm_metadata') continue
    if (TIMESTAMP_KEYS.has(k)) continue
    if (HIDDEN_TURN_METRIC_KEYS.has(k)) continue
    if (typeof v !== 'number' || !Number.isFinite(v)) continue

    const isTiming = k in TIMING_LABELS || TIMING_KEY_PATTERN.test(k)
    chips.push({
      key: k,
      label: TIMING_LABELS[k] ?? humanize(k),
      value: isTiming ? formatMs(v * 1000) : String(v),
    })
  }

  const meta = metrics.llm_metadata
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const m = meta as Record<string, unknown>
    if (typeof m.model_name === 'string' && m.model_name) {
      chips.push({ key: 'model', label: 'Model', value: m.model_name })
    }
    for (const [tk, label] of Object.entries(TOKEN_LABELS)) {
      const val = m[tk]
      if (typeof val === 'number' && Number.isFinite(val)) {
        chips.push({ key: tk, label, value: String(val) })
      }
    }
  }

  return chips
}

function MessageRow({ event, index }: { event: RunEventMessage; index: number }) {
  const chips =
    event.metrics && typeof event.metrics === 'object'
      ? buildMetricChips(event.metrics as Record<string, unknown>)
      : []
  const role = event.role ?? 'assistant'
  const isUser = role === 'user'

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden shadow-[var(--ao-shadow-sm)]">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/60 border-b border-border">
        <span
          className={cn(
            'inline-flex items-center h-[18px] px-1.5 rounded font-mono text-xxs-600 uppercase tracking-wider',
            isUser
              ? 'bg-[var(--ao-accent-soft)] text-[var(--ao-accent)]'
              : 'bg-card text-foreground border border-border',
          )}
        >
          {role}
        </span>
        {event.interrupted && (
          <Badge variant="outline" className="text-xxs-600 text-warning border-[hsl(var(--warning-border))]">
            interrupted
          </Badge>
        )}
        <span className="ml-auto text-xxs-400 font-mono tabular-nums text-muted-foreground">
          #{index}
        </span>
      </div>
      <div className="p-3 text-s-400 whitespace-pre-wrap text-foreground">{event.content ?? ''}</div>
      {chips.length > 0 && (
        <div className="border-t border-border bg-muted/30 px-3 py-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xxs-400 font-mono tabular-nums">
          {chips.map((c) => (
            <span key={c.key} className="inline-flex items-baseline gap-1">
              <span className="text-muted-foreground">{c.label}</span>
              <span className="text-foreground">{c.value}</span>
            </span>
          ))}
        </div>
      )}
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
  const headerLabel = call ? `${call.name ?? 'unknown'}` : 'tool result'

  return (
    <Collapsible className="rounded-lg border border-border bg-card overflow-hidden shadow-[var(--ao-shadow-sm)]">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-1.5 bg-muted/60 text-foreground text-xs-600 cursor-pointer hover:bg-muted data-[state=open]:border-b border-border">
        <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90 text-muted-foreground" />
        <Wrench className="h-3 w-3 text-[var(--ao-accent)]" />
        <span className="font-mono">{headerLabel}</span>
        {output?.is_error && (
          <span className="ao-badge is-danger" style={{ height: 18 }}>
            error
          </span>
        )}
        <span className="ml-auto text-xxs-400 font-mono tabular-nums text-muted-foreground">
          #{index}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
        {call && (
          <>
            <div className="px-3 pt-2 pb-1 text-xxs-600 text-muted-foreground uppercase tracking-wider font-mono">
              Input
            </div>
            {argsEmpty ? (
              <div className="px-3 pb-3 text-xs-400 italic text-muted-foreground">
                No arguments recorded.
              </div>
            ) : (
              <pre className="px-3 pb-3 text-xs-400 font-mono whitespace-pre overflow-x-auto text-foreground">
                {argsStr}
              </pre>
            )}
          </>
        )}
        {output && (
          <>
            <div className="px-3 pt-2 pb-1 text-xxs-600 text-muted-foreground uppercase tracking-wider font-mono">
              Output
            </div>
            {outputEmpty ? (
              <div className="px-3 pb-3 text-s-400 italic text-muted-foreground">
                No output recorded.
              </div>
            ) : (
              <pre className="px-3 pb-3 text-s-400 font-mono whitespace-pre-wrap break-words text-foreground">
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
        className="rounded-lg border border-border bg-card px-3 py-2 text-xs-400 text-muted-foreground font-mono"
      >
        {ev.type}
      </div>
    )
  })
}

// Per-criterion verdict tone. Maps the judge verdict onto the shared semantic
// classes so pass/fail/other read consistently in light + dark.
type JudgmentTone = 'pass' | 'fail' | 'other'
function verdictTone(v: JudgmentVerdict): JudgmentTone {
  return v === 'pass' ? 'pass' : v === 'fail' ? 'fail' : 'other'
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
      <div className="flex flex-col gap-5 px-[22px] py-[18px]" aria-busy="true">
        <div className="flex flex-col gap-3">
          <div className="ao-skeleton ao-skeleton--title" style={{ width: '40%' }} />
          <div className="ao-skeleton ao-skeleton--line" style={{ width: '60%' }} />
        </div>
        <div className="ao-stat-row">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="ao-stat">
              <div className="ao-skeleton ao-skeleton--line" style={{ width: '50%' }} />
              <div className="ao-skeleton" style={{ height: 30, width: '70%', marginTop: 8 }} />
            </div>
          ))}
        </div>
        <div className="ao-panel">
          <div className="ao-panel-body flex flex-col gap-3">
            <div className="ao-skeleton ao-skeleton--title" style={{ width: '30%' }} />
            <div className="ao-skeleton ao-skeleton--line" />
            <div className="ao-skeleton ao-skeleton--line" style={{ width: '80%' }} />
          </div>
        </div>
      </div>
    )
  }

  if (error || !evalCase) {
    return (
      <div className="px-[22px] py-[18px]">
        <div className="ao-empty">
          <div className="ao-empty-icon">
            <AlertTriangle />
          </div>
          <div className="ao-empty-title">Couldn’t load this case</div>
          <div className="ao-empty-text">{error ?? 'The case was not found for this run.'}</div>
          {onBack && (
            <div className="ao-empty-actions">
              <button type="button" className="ao-btn ao-btn--outline" onClick={onBack}>
                <ArrowLeft /> Back to run
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  const judgments = evalCase.judgments
  const passCount = judgments.filter((j) => j.verdict === 'pass').length
  const failCount = judgments.filter((j) => j.verdict === 'fail').length
  const showAggregate = summary != null && summary.turnsWithMetrics >= 2

  return (
    <>
      {/* Sticky-feel control bar: back + close, present in both the full-page
          route and the drawer mount. */}
      <div className="flex items-center justify-between gap-2 px-[18px] py-3 border-b border-border bg-card/60">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="h-auto p-0 gap-1.5 text-s-500 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to run
        </Button>
        <span className="ml-auto text-xxs-400 font-mono text-muted-foreground hidden sm:inline">
          run {runId.slice(0, 8)} · case {caseId.slice(0, 8)}
        </span>
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

      <div className="px-[22px] py-[18px] pb-[34px] flex flex-col gap-5">
        {/* Hero header — case identity + judged result front and center. */}
        <header className="ao-hero ao-hero--bare ao-reveal">
          <div className="min-w-0">
            <div className="ao-hero-eyebrow">
              <ScrollText /> Eval case
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="ao-hero-title font-mono break-all" style={{ fontSize: 26 }}>
                {evalCase.name}
              </h1>
              <StatusBadge status={evalCase.status} />
            </div>
            <div className="ao-hero-sub flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs-400">
              {evalCase.file && (
                <>
                  <span className="break-all">{evalCase.file}</span>
                  <span className="text-border">·</span>
                </>
              )}
              <span>{formatDuration(evalCase.duration_ms)}</span>
              {showAggregate && summary && summary.models.length > 0 && (
                <>
                  <span className="text-border">·</span>
                  <span>
                    {summary.models.length === 1 ? 'Model' : 'Models'}{' '}
                    {summary.models.join(', ')}
                  </span>
                </>
              )}
            </div>
          </div>
        </header>

        {/* KPI tiles — the case's headline numbers. */}
        <div className="ao-stat-row ao-stagger">
          <div
            className={cn(
              'ao-stat ao-stat--feature',
              evalCase.status === 'passed'
                ? 'is-good'
                : evalCase.status === 'failed'
                  ? 'is-bad'
                  : evalCase.status === 'errored'
                    ? 'is-warn'
                    : 'is-accent',
            )}
          >
            <div className="ao-stat-label">
              {evalCase.status === 'passed' ? (
                <CheckCircle2 />
              ) : evalCase.status === 'failed' ? (
                <XCircle />
              ) : (
                <CircleHelp />
              )}
              Result
            </div>
            <div className="ao-stat-value" style={{ fontSize: 26 }}>
              {STATUS_LABEL[evalCase.status]}
            </div>
            {judgments.length > 0 && (
              <div className="ao-stat-meta">
                <span className="ao-delta-up">{passCount} pass</span>
                {failCount > 0 && (
                  <>
                    <span className="text-border">·</span>
                    <span className="ao-delta-down">{failCount} fail</span>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="ao-stat">
            <div className="ao-stat-label">
              <Clock /> Duration
            </div>
            <div className="ao-stat-value">{formatDuration(evalCase.duration_ms)}</div>
          </div>

          <div className="ao-stat">
            <div className="ao-stat-label">
              <MessageSquareText /> Events
            </div>
            <div className="ao-stat-value">{evalCase.events.length}</div>
            {judgments.length > 0 && (
              <div className="ao-stat-meta">
                {judgments.length} judgment{judgments.length !== 1 ? 's' : ''}
              </div>
            )}
          </div>

          <div className="ao-stat">
            <div className="ao-stat-label">
              {showAggregate && summary?.avgTtftMs != null ? <Gauge /> : <Cpu />}
              {showAggregate && summary?.avgTtftMs != null ? 'Avg TTFT' : 'Turns w/ metrics'}
            </div>
            <div className="ao-stat-value">
              {showAggregate && summary?.avgTtftMs != null
                ? formatMs(summary.avgTtftMs)
                : (summary?.turnsWithMetrics ?? 0)}
            </div>
          </div>
        </div>

        {/* Recording — the live call's audio (Truman-proxied), like Truman's UI. */}
        {evalCase.recording_url && (
          <section className="ao-scriptbox ao-reveal ao-reveal-1">
            <div className="ao-scriptbox-cap"><AudioLines size={12} /> Recording</div>
            <div className="ao-scriptbox-body">
              <audio controls preload="none" src={evalCase.recording_url} className="w-full" />
            </div>
          </section>
        )}

        {/* Judgments — the judged-result detail, given top billing. */}
        {judgments.length > 0 && (
          <section className="ao-panel ao-reveal ao-reveal-1">
            <div className="ao-panel-head">
              <div>
                <div className="ao-panel-title">
                  <CheckCircle2 /> Judgments
                </div>
                <div className="ao-panel-sub">
                  {passCount}/{judgments.length} criteria passed
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {passCount > 0 && <span className="ao-badge is-success">{passCount} pass</span>}
                {failCount > 0 && <span className="ao-badge is-danger">{failCount} fail</span>}
              </div>
            </div>
            <div className="ao-panel-body flex flex-col gap-2.5">
              {judgments.map((j, i) => {
                const tone = verdictTone(j.verdict)
                return (
                  <div
                    key={`${j.intent}-${i}`}
                    className={cn(
                      'rounded-lg border px-3.5 py-3',
                      tone === 'pass' &&
                        'border-[hsl(var(--success-border))] bg-[hsl(var(--success-bg))]',
                      tone === 'fail' &&
                        'border-[hsl(var(--destructive-border))] bg-[hsl(var(--destructive-bg))]',
                      tone === 'other' && 'border-border bg-muted/40',
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2 min-w-0">
                        {tone === 'pass' ? (
                          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-success" />
                        ) : tone === 'fail' ? (
                          <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
                        ) : (
                          <CircleHelp className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                        )}
                        <p className="text-s-500 m-0 text-foreground">{j.intent}</p>
                      </div>
                      <span
                        className={cn(
                          'ao-badge shrink-0',
                          tone === 'pass'
                            ? 'is-success'
                            : tone === 'fail'
                              ? 'is-danger'
                              : 'is-neutral',
                        )}
                      >
                        {tone === 'pass' ? 'pass' : tone === 'fail' ? 'fail' : 'maybe'}
                      </span>
                    </div>
                    {j.reasoning && (
                      <p className="mt-2 ml-6 text-s-400 text-muted-foreground whitespace-pre-wrap">
                        {j.reasoning}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* Failure — surfaced right under the verdict when present. */}
        {evalCase.failure && (
          <section className="ao-panel ao-reveal ao-reveal-2">
            <div className="ao-panel-head">
              <div className="ao-panel-title text-destructive">
                <AlertTriangle /> Failure
              </div>
              <span className="ao-badge is-danger font-mono">{evalCase.failure.kind}</span>
            </div>
            <div className="ao-panel-body flex flex-col gap-3">
              {evalCase.failure.message && (
                <div className="ao-alert is-danger">
                  <AlertTriangle />
                  <span className="whitespace-pre-wrap">{evalCase.failure.message}</span>
                </div>
              )}
              {evalCase.failure.stack && (
                <Collapsible>
                  <CollapsibleTrigger className="ao-section-label hover:text-foreground cursor-pointer bg-transparent border-none p-0">
                    Stack trace
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-2">
                    <pre className="border border-border rounded-lg bg-muted/40 px-3 py-2.5 font-mono text-xs-400 text-muted-foreground whitespace-pre-wrap break-words max-h-[200px] overflow-auto">
                      {evalCase.failure.stack}
                    </pre>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </div>
          </section>
        )}

        {/* User input — the prompt that drove the case. */}
        {evalCase.user_input && (
          <section className="ao-panel ao-reveal ao-reveal-3">
            <div className="ao-panel-head">
              <div className="ao-panel-title">
                <Hash /> User input
              </div>
            </div>
            <div className="ao-panel-body">
              <div className="border-l-2 border-[var(--ao-accent)] rounded-r-md bg-muted/40 px-3.5 py-3 text-s-400 text-foreground whitespace-pre-wrap">
                {evalCase.user_input}
              </div>
            </div>
          </section>
        )}

        {/* Transcript / events — Truman-style "script readout" framing. */}
        <section className="ao-scriptbox ao-reveal ao-reveal-4">
          <div className="ao-scriptbox-cap">
            <ScrollText size={12} /> Transcript · {evalCase.events.length} event{evalCase.events.length !== 1 ? 's' : ''}
          </div>
          <div className="ao-scriptbox-body">
            {evalCase.events.length === 0 ? (
              <div className="text-s-400 text-muted-foreground italic">No events recorded.</div>
            ) : (
              <div className="flex flex-col gap-2.5">{renderTranscript(evalCase.events)}</div>
            )}
          </div>
        </section>
      </div>
    </>
  )
}
