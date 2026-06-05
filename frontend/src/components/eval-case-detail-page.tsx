/* eval-case-detail-page.tsx — single eval case, mirroring the Simulate report
 * layout (NO drawer). Full-width header + KPI strip, then a FULL-WIDTH wide
 * transcript (+ recording), then the summary sections (judgments, failure,
 * user input) as full-width rows below — so the transcript is roomy and the
 * page is short. Backs to the run detail. */
import { useMemo } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  AudioLines,
  CheckCircle2,
  CircleHelp,
  Clock,
  Cpu,
  Gauge,
  Hash,
  MessageSquareText,
  ScrollText,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDuration, formatMs } from '@/lib/observability-format'
import { useEvalCase } from '@/lib/observability-hooks'
import type { CaseStatus, JudgmentVerdict, RunEvent, RunEventMessage } from '@/lib/observability-types'
import { EvalTranscript } from '@/components/run-detail/eval-transcript'
import { SectionTitle } from '@/components/run-detail/report-sections'
import { AudioPlayer } from '@/components/run-detail/audio-player'

interface MetricsSummary {
  turnsWithMetrics: number
  avgTtftMs: number | null
  models: string[]
}

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

const STATUS_TONE: Record<CaseStatus, string> = {
  passed: 'is-success',
  failed: 'is-danger',
  errored: 'is-warning',
  skipped: 'is-neutral',
}
const STATUS_LABEL: Record<CaseStatus, string> = {
  passed: 'Passed',
  failed: 'Failed',
  errored: 'Errored',
  skipped: 'Skipped',
}

function StatusBadge({ status }: { status: CaseStatus }) {
  return <span className={cn('ao-badge ao-badge--dot', STATUS_TONE[status])}>{STATUS_LABEL[status]}</span>
}

function verdictTone(v: JudgmentVerdict): 'pass' | 'fail' | 'other' {
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
  const summary = useMemo(() => (evalCase ? computeCaseMetrics(evalCase.events) : null), [evalCase])

  if (loading) {
    return (
      <div className="flex flex-col gap-5 p-6" aria-busy="true">
        <div className="ao-skeleton ao-skeleton--title" style={{ width: '40%' }} />
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
      <div className="p-6">
        <div className="ao-empty">
          <div className="ao-empty-icon"><AlertTriangle /></div>
          <div className="ao-empty-title">Couldn’t load this case</div>
          <div className="ao-empty-text">{error ?? 'The case was not found for this run.'}</div>
          {onBack && (
            <div className="ao-empty-actions">
              <button type="button" className="ao-btn ao-btn--outline" onClick={onBack}><ArrowLeft /> Back to run</button>
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
    <div className="flex flex-col gap-6 p-6">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="inline-flex w-fit cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to run
        </button>
      )}

      {/* full-width header */}
      <header className="ao-hero ao-hero--bare">
        <div className="min-w-0">
          <div className="ao-hero-eyebrow"><ScrollText /> Eval case</div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="ao-hero-title break-all font-mono" style={{ fontSize: 26 }}>{evalCase.name}</h1>
            <StatusBadge status={evalCase.status} />
          </div>
          <div className="ao-hero-sub flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs">
            {evalCase.file && (<><span className="break-all">{evalCase.file}</span><span className="text-border">·</span></>)}
            <span>{formatDuration(evalCase.duration_ms)}</span>
            {showAggregate && summary && summary.models.length > 0 && (
              <><span className="text-border">·</span><span>{summary.models.length === 1 ? 'Model' : 'Models'} {summary.models.join(', ')}</span></>
            )}
          </div>
        </div>
      </header>

      {/* KPI strip */}
      <div className="ao-stat-row ao-stagger">
        <div className={cn('ao-stat ao-stat--feature', evalCase.status === 'passed' ? 'is-good' : evalCase.status === 'failed' ? 'is-bad' : evalCase.status === 'errored' ? 'is-warn' : 'is-accent')}>
          <div className="ao-stat-label">
            {evalCase.status === 'passed' ? <CheckCircle2 /> : evalCase.status === 'failed' ? <XCircle /> : <CircleHelp />} Result
          </div>
          <div className="ao-stat-value" style={{ fontSize: 26 }}>{STATUS_LABEL[evalCase.status]}</div>
          {judgments.length > 0 && (
            <div className="ao-stat-meta">
              <span className="ao-delta-up">{passCount} pass</span>
              {failCount > 0 && <><span className="text-border">·</span><span className="ao-delta-down">{failCount} fail</span></>}
            </div>
          )}
        </div>
        <div className="ao-stat">
          <div className="ao-stat-label"><Clock /> Duration</div>
          <div className="ao-stat-value">{formatDuration(evalCase.duration_ms)}</div>
        </div>
        <div className="ao-stat">
          <div className="ao-stat-label"><MessageSquareText /> Events</div>
          <div className="ao-stat-value">{evalCase.events.length}</div>
          {judgments.length > 0 && <div className="ao-stat-meta">{judgments.length} judgment{judgments.length !== 1 ? 's' : ''}</div>}
        </div>
        <div className="ao-stat">
          <div className="ao-stat-label">
            {showAggregate && summary?.avgTtftMs != null ? <Gauge /> : <Cpu />}
            {showAggregate && summary?.avgTtftMs != null ? 'Avg TTFT' : 'Turns w/ metrics'}
          </div>
          <div className="ao-stat-value">
            {showAggregate && summary?.avgTtftMs != null ? formatMs(summary.avgTtftMs) : (summary?.turnsWithMetrics ?? 0)}
          </div>
        </div>
      </div>

      {/* Transcript — full-width & wide, with the recording inline below it */}
      <div className="ao-panel">
        <div className="ao-panel-head">
          <SectionTitle icon={<ScrollText size={16} className="text-muted-foreground" />} title="Transcript" hint="full conversation" />
          <span className="ao-panel-sub">{evalCase.events.length} event{evalCase.events.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="max-h-[72vh] overflow-auto p-4">
          <EvalTranscript events={evalCase.events} />
        </div>
        {evalCase.recording_url && (
          <div className="flex items-center gap-2.5 border-t border-border px-4 py-3">
            <AudioLines size={16} className="shrink-0 text-muted-foreground" />
            <AudioPlayer src={evalCase.recording_url} className="flex-1" durationHint={evalCase.cost?.call_seconds} />
          </div>
        )}
      </div>

      {/* Summary sections — full-width rows below the transcript */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
          {judgments.length > 0 && (
            <div className="ao-panel">
              <div className="ao-panel-head">
                <SectionTitle icon={<CheckCircle2 size={16} className="text-success" />} title="Judgments" hint="per-criterion pass / fail" />
                <span className="ao-panel-sub">{passCount}/{judgments.length} passed</span>
              </div>
              <div className="flex flex-col gap-2.5 p-4">
                {judgments.map((j, i) => {
                  const tone = verdictTone(j.verdict)
                  return (
                    <div
                      key={`${j.intent}-${i}`}
                      className={cn(
                        'rounded-lg border px-3.5 py-3',
                        tone === 'pass' && 'border-[hsl(var(--success-border))] bg-[hsl(var(--success-bg))]',
                        tone === 'fail' && 'border-[hsl(var(--destructive-border))] bg-[hsl(var(--destructive-bg))]',
                        tone === 'other' && 'border-border bg-muted/40',
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-2">
                          {tone === 'pass' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                            : tone === 'fail' ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                              : <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                          <p className="m-0 text-sm text-foreground">{j.intent}</p>
                        </div>
                        <span className={cn('ao-badge shrink-0', tone === 'pass' ? 'is-success' : tone === 'fail' ? 'is-danger' : 'is-neutral')}>
                          {tone === 'pass' ? 'pass' : tone === 'fail' ? 'fail' : 'maybe'}
                        </span>
                      </div>
                      {j.reasoning && <p className="ml-6 mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{j.reasoning}</p>}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {evalCase.failure && (
            <div className="ao-panel">
              <div className="ao-panel-head">
                <SectionTitle icon={<AlertTriangle size={16} className="text-destructive" />} title="Failure" hint="why this case failed" />
                <span className="ao-badge is-danger font-mono">{evalCase.failure.kind}</span>
              </div>
              <div className="flex flex-col gap-3 p-4">
                {evalCase.failure.message && (
                  <div className="ao-alert is-danger"><AlertTriangle /><span className="whitespace-pre-wrap">{evalCase.failure.message}</span></div>
                )}
                {evalCase.failure.stack && (
                  <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 px-3 py-2.5 font-mono text-xs text-muted-foreground">
                    {evalCase.failure.stack}
                  </pre>
                )}
              </div>
            </div>
          )}

          {evalCase.user_input && (
            <div className="ao-panel">
              <div className="ao-panel-head">
                <SectionTitle icon={<Hash size={16} className="text-muted-foreground" />} title="User input" hint="the prompt that drove the case" />
              </div>
              <div className="ao-panel-body">
                <div className="rounded-r-md border-l-2 border-[var(--ao-accent)] bg-muted/40 px-3.5 py-3 text-sm text-foreground whitespace-pre-wrap">
                  {evalCase.user_input}
                </div>
              </div>
            </div>
          )}
      </div>
    </div>
  )
}
