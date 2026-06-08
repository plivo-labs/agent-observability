/* eval-run-detail-page.tsx — run detail, mirroring the Simulate report layout:
 * full-width stacked sections that use horizontal space (so the page is short
 * and the transcript is wide). NO drawer / Sheet. Top-to-bottom:
 *   1. Header + KPI strip (full width).
 *   2. Case / persona selector — prominent full-width row (multi-case only),
 *      drives the per-case views below.
 *   3. Run result — Scorer | Rubric (2-col), only when sim_report is present.
 *   4. Worst moments, then Recommended fixes (full-width stacked) — sim_report.
 *   5. Leveled judge (full-width) — only when sim_report.
 *   6. Case result / judgments — full-width row for the selected case.
 *   7. Transcript — full-width transcript + recording for the selected case.
 * sim_report-only sections simply don't render for live-call / pytest runs. */
import { useMemo } from 'react'
import { parseAsString, useQueryState } from 'nuqs'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  AudioLines,
  Bot,
  CheckCircle2,
  CircleHelp,
  ExternalLink,
  FlaskConical,
  GitBranch,
  GitCommit,
  Phone,
  ScrollText,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDate, formatDuration, formatMs } from '@/lib/observability-format'
import { useEvalRun } from '@/lib/observability-hooks'
import type {
  CaseStatus,
  EvalCaseRow,
  SimReport,
  SimReportJudgeTree,
  RunEvent,
  RunEventMessage,
} from '@/lib/observability-types'
import { EvalTranscript } from '@/components/run-detail/eval-transcript'
import { AudioPlayer } from '@/components/run-detail/audio-player'
import { PersonaSelector } from '@/components/run-detail/persona-selector'
import { JudgmentsPanel } from '@/components/run-detail/judgments-panel'
import {
  FixesBox,
  LeveledJudgeBox,
  RubricBox,
  ScorerBox,
  SectionTitle,
  WorstMomentsBox,
} from '@/components/run-detail/report-sections'

/** Maps a case status to its `ao-badge` tone modifier. */
const STATUS_BADGE_TONE: Record<CaseStatus, string> = {
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

/** Look up a case's leveled-judge tree from `sim_report.caseTrees`, preferring
 *  the stable `case_id` key (current producer) and falling back to the persona
 *  `name` key (older persisted runs). Keying by `case_id` avoids the collision
 *  that duplicate persona names caused with the old name-keyed lookup. */
function caseTreeFor(report: SimReport | null, c: EvalCaseRow): SimReportJudgeTree | undefined {
  if (!report?.caseTrees) return undefined
  return report.caseTrees[c.case_id] ?? report.caseTrees[c.name]
}

/** Mean of `metrics.llm_node_ttft` (seconds → ms) across message events. */
function caseAvgTtftMs(events: RunEvent[]): number | null {
  const ttfts: number[] = []
  for (const ev of events) {
    if (ev.type !== 'message') continue
    const ttft = (ev as RunEventMessage).metrics?.llm_node_ttft
    if (typeof ttft === 'number') ttfts.push(ttft * 1000)
  }
  return ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null
}

type StatTone = 'good' | 'warn' | 'bad' | 'zero' | 'default'

function statToneClass(tone: StatTone): string {
  switch (tone) {
    case 'good': return 'is-good'
    case 'warn': return 'is-warn'
    case 'bad': return 'is-bad'
    default: return ''
  }
}

function StatCard({
  label, value, suffix, tone = 'default', meterPct, feature, icon,
}: {
  label: string
  value: string | number
  suffix?: string
  tone?: StatTone
  meterPct?: number
  feature?: boolean
  icon?: React.ReactNode
}) {
  const meterClass =
    tone === 'good' ? 'bg-[hsl(var(--success-fg,var(--success)))]'
      : tone === 'warn' ? 'bg-[hsl(var(--warning-fg,var(--warning)))]'
        : tone === 'bad' ? 'bg-[hsl(var(--destructive))]'
          : tone === 'zero' ? 'bg-muted-foreground/40' : 'bg-foreground'
  return (
    <div className={cn('ao-stat relative overflow-hidden', feature && 'ao-stat--feature', statToneClass(tone))}>
      <div className="ao-stat-label">{icon}{label}</div>
      <div className={cn('ao-stat-value', tone === 'zero' && 'text-muted-foreground')}>
        {value}{suffix && <span className="unit">{suffix}</span>}
      </div>
      {meterPct != null && (
        <div className="absolute left-0 right-0 bottom-0 h-[3px] bg-muted">
          <div className={cn('h-full transition-[width]', meterClass)} style={{ width: `${Math.max(0, Math.min(100, meterPct))}%` }} />
        </div>
      )}
    </div>
  )
}

function passRateTone(pct: number): StatTone {
  if (pct >= 100) return 'good'
  if (pct >= 70) return 'warn'
  return 'bad'
}

/* ---------- case summary (right column) ---------- */
function CaseSummary({ c }: { c: EvalCaseRow }) {
  const judgments = c.judgments
  const passCount = judgments.filter((j) => j.verdict === 'pass').length
  const failCount = judgments.filter((j) => j.verdict === 'fail').length
  return (
    <>
      <div className="ao-panel">
        <div className="ao-panel-head">
          <SectionTitle
            icon={c.status === 'passed' ? <CheckCircle2 size={16} className="text-success" /> : c.status === 'failed' ? <XCircle size={16} className="text-destructive" /> : <CircleHelp size={16} className="text-muted-foreground" />}
            title="Case result"
            hint="this case's verdict & criteria"
          />
          <span className={cn('ao-badge ao-badge--dot', STATUS_BADGE_TONE[c.status])}>{STATUS_LABEL[c.status]}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-4 text-sm text-muted-foreground">
          <span>Duration <b className="text-foreground tabular-nums">{formatDuration(c.duration_ms)}</b></span>
          <span>Events <b className="text-foreground tabular-nums">{c.events.length}</b></span>
          {judgments.length > 0 && (
            <span><b className="text-success">{passCount} pass</b>{failCount > 0 && <> · <b className="text-destructive">{failCount} fail</b></>}</span>
          )}
        </div>
      </div>

      <JudgmentsPanel judgments={judgments} />

      {/* Cost — live-call cases only (joined from sim_live_calls.cost).
          Mirrors the Live suite report's Cost section layout/labels. */}
      {c.cost && (
        <div className="ao-panel">
          <div className="ao-panel-head">
            <SectionTitle icon={<Activity size={16} className="text-muted-foreground" />} title="Cost" hint="per-call usage breakdown" />
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 p-4 text-sm">
            {[['LLM tokens', c.cost.llm_tokens.toLocaleString()], ['TTS chars', c.cost.tts_chars.toLocaleString()], ['STT secs', `${c.cost.stt_seconds}`], ['Call secs', `${c.cost.call_seconds}`]].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between"><span className="text-muted-foreground">{k}</span><span className="font-mono text-xs">{v}</span></div>
            ))}
            <div className="col-span-2 mt-1 flex items-center justify-between border-t border-border pt-2"><span className="text-muted-foreground">Total</span><span className="font-semibold">{c.cost.cents}¢</span></div>
          </div>
        </div>
      )}

      {c.failure && (
        <div className="ao-panel">
          <div className="ao-panel-head">
            <SectionTitle icon={<AlertTriangle size={16} className="text-destructive" />} title="Failure" hint="why this case failed" />
            <span className="ao-badge is-danger font-mono">{c.failure.kind}</span>
          </div>
          <div className="flex flex-col gap-3 p-4">
            {c.failure.message && (
              <div className="ao-alert is-danger"><AlertTriangle /><span className="whitespace-pre-wrap">{c.failure.message}</span></div>
            )}
            {c.failure.stack && (
              <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 px-3 py-2.5 font-mono text-xs text-muted-foreground">
                {c.failure.stack}
              </pre>
            )}
          </div>
        </div>
      )}
    </>
  )
}

export const EvalRunDetailPage = ({
  runId,
  onBack,
}: {
  runId: string
  onBack?: () => void
}) => {
  const { run, loading, error } = useEvalRun(runId)
  const report = run?.sim_report ?? null
  const [selectedCaseId, setSelectedCaseId] = useQueryState('case', parseAsString)

  const stats = useMemo(() => {
    if (!run) return null
    const passRate = run.total > 0 ? Math.round((run.passed / run.total) * 100) : 0
    const allTtfts: number[] = []
    for (const c of run.cases) {
      for (const ev of c.events) {
        if (ev.type !== 'message') continue
        const ttft = (ev as RunEventMessage).metrics?.llm_node_ttft
        if (typeof ttft === 'number') allTtfts.push(ttft * 1000)
      }
    }
    const avgTtftMs = allTtfts.length ? allTtfts.reduce((a, b) => a + b, 0) / allTtfts.length : null
    return {
      passRate,
      passedPct: run.total > 0 ? (run.passed / run.total) * 100 : 0,
      failedPct: run.total > 0 ? (run.failed / run.total) * 100 : 0,
      avgTtftMs,
    }
  }, [run])

  // Default the selected case to the first failing case (most interesting),
  // else the first case. URL `?case=` overrides.
  const selectedCase = useMemo<EvalCaseRow | null>(() => {
    if (!run || run.cases.length === 0) return null
    if (selectedCaseId) {
      const found = run.cases.find((c) => c.case_id === selectedCaseId)
      if (found) return found
    }
    return run.cases.find((c) => c.status === 'failed' || c.status === 'errored') ?? run.cases[0]
  }, [run, selectedCaseId])

  const caseAvg = selectedCase ? caseAvgTtftMs(selectedCase.events) : null

  if (loading) {
    return (
      <div className="flex flex-col gap-6 p-6" aria-busy="true">
        <div className="ao-skeleton ao-skeleton--title" style={{ width: 280 }} />
        <div className="ao-stat-row">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="ao-stat">
              <div className="ao-skeleton" style={{ height: 12, width: '50%' }} />
              <div className="ao-skeleton" style={{ height: 30, width: '60%', marginTop: 10 }} />
            </div>
          ))}
        </div>
        <div className="ao-panel">
          <div className="ao-panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="ao-skeleton ao-skeleton--line" />
            <div className="ao-skeleton ao-skeleton--line" style={{ width: '85%' }} />
            <div className="ao-skeleton ao-skeleton--line" style={{ width: '70%' }} />
          </div>
        </div>
      </div>
    )
  }

  if (error || !run || !stats) {
    return (
      <div className="p-6">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="mb-5 inline-flex w-fit cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to evals
          </button>
        )}
        <div className="ao-empty">
          <div className="ao-empty-icon"><AlertTriangle /></div>
          <div className="ao-empty-title">Couldn't load this eval run</div>
          <div className="ao-empty-text">{error ?? 'The run was not found, or has been deleted.'}</div>
          {onBack && (
            <div className="ao-empty-actions">
              <button type="button" className="ao-btn ao-btn--outline" onClick={onBack}><ArrowLeft className="h-3.5 w-3.5" /> Back to evals</button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex flex-col gap-6 p-6">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="ao-reveal inline-flex w-fit cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to evals
        </button>
      )}

      {/* full-width header */}
      <header className="ao-hero ao-reveal ao-reveal-1">
        <div className="min-w-0">
          <div className="ao-hero-eyebrow"><FlaskConical /> Eval run</div>
          <h1 className="ao-hero-title truncate">
            {run.agent_id ?? <span className="text-muted-foreground">Unnamed agent</span>}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {run.framework && (
              <span className="ao-badge is-neutral">
                <Bot className="h-3 w-3 shrink-0" />{run.framework}
                {run.framework_version && <span className="ao-mono ml-0.5">{run.framework_version}</span>}
              </span>
            )}
            <span className="ao-badge is-neutral">
              <FlaskConical className="h-3 w-3 shrink-0" />{run.testing_framework}
              {run.testing_framework_version && <span className="ao-mono ml-0.5">{run.testing_framework_version}</span>}
            </span>
            {run.dialed_number && (
              <span className="ao-badge is-neutral">
                <Phone className="h-3 w-3 shrink-0" />Dialed <span className="ao-mono ml-0.5">{run.dialed_number}</span>
              </span>
            )}
            <span className="ao-mono">{run.run_id}</span>
          </div>
        </div>
        <div className="ao-hero-actions">
          <div className="text-right text-sm text-muted-foreground">
            <b className="block text-foreground">Started {formatDate(run.started_at)}</b>
            <span className="ao-mono">Duration {formatDuration(run.duration_ms)}</span>
          </div>
        </div>
      </header>

      {/* full-width KPI strip */}
      <div className="ao-stat-row ao-stagger">
        <StatCard label="Pass rate" value={stats.passRate} suffix="%" tone={passRateTone(stats.passRate)} meterPct={stats.passRate} feature />
        <StatCard label="Passed" value={run.passed} tone={run.passed > 0 ? 'good' : 'zero'} meterPct={stats.passedPct} />
        <StatCard label="Failed" value={run.failed} tone={run.failed > 0 ? 'bad' : 'zero'} meterPct={stats.failedPct} />
        {run.errored > 0 && <StatCard label="Errored" value={run.errored} tone="bad" />}
        {run.skipped > 0 && <StatCard label="Skipped" value={run.skipped} tone="warn" />}
        {stats.avgTtftMs != null && <StatCard label="Avg TTFT" value={formatMs(stats.avgTtftMs)} tone="default" />}
      </div>

      {run.ci && (
        <section className="ao-panel ao-reveal ao-reveal-2">
          <div className="ao-panel-head">
            <div className="ao-panel-title"><GitBranch /> Continuous integration</div>
            {run.ci.run_url && (
              <a href={String(run.ci.run_url)} target="_blank" rel="noreferrer" className="ao-btn ao-btn--ghost ao-btn--sm">
                View run <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <div className="ao-panel-body flex flex-wrap items-center gap-x-6 gap-y-2.5">
            {run.ci.provider && (
              <div className="flex flex-col gap-0.5"><span className="ao-section-label">Provider</span><span className="text-sm capitalize">{String(run.ci.provider)}</span></div>
            )}
            {run.ci.git_branch && (
              <div className="flex flex-col gap-0.5"><span className="ao-section-label">Branch</span><span className="inline-flex items-center gap-1.5 text-sm"><GitBranch className="h-3.5 w-3.5 text-muted-foreground" />{String(run.ci.git_branch)}</span></div>
            )}
            {run.ci.git_sha && (
              <div className="flex flex-col gap-0.5"><span className="ao-section-label">Commit</span><span className="inline-flex items-center gap-1.5 ao-mono"><GitCommit className="h-3.5 w-3.5 text-muted-foreground" />{String(run.ci.git_sha).slice(0, 7)}</span></div>
            )}
          </div>
        </section>
      )}

      {/* Run result — Scorer | Rubric, 2-col full-width row (sim_report only) */}
      {report && (
        <div className="grid grid-cols-1 items-stretch gap-5 lg:grid-cols-2">
          <ScorerBox report={report} />
          <RubricBox report={report} rubricName={run.agent_id} />
        </div>
      )}

      {/* Worst moments, then Recommended fixes — full-width stacked rows
          (Worst moments is short, so stacking avoids an empty void) (sim_report only) */}
      {report && (
        <>
          <WorstMomentsBox report={report} />
          <FixesBox report={report} />
        </>
      )}

      {/* Case / persona selector — sits right above the per-case views it drives
          (leveled judge, case result, transcript). Multi-case only. Shared with Simulate. */}
      {run.cases.length > 1 && selectedCase && (
        <PersonaSelector
          label={run.cases.some((c) => c.judgments.length > 0) ? 'Persona' : 'Case'}
          items={run.cases.map((c) => ({
            id: c.case_id,
            name: c.name,
            status: c.status === 'passed' ? 'pass' : c.status === 'failed' || c.status === 'errored' ? 'fail' : 'other',
            score: caseTreeFor(report, c)?.flow?.score,
          }))}
          selectedId={selectedCase.case_id}
          onSelect={(id) => void setSelectedCaseId(id)}
        />
      )}

      {/* Leveled judge — full-width row (sim_report only). Renders the SELECTED
          persona's per-case tree (keyed by case_id), falling back to the
          run-level worst-case tree for older runs that lack `caseTrees`. */}
      {report?.judgeTree && (
        <LeveledJudgeBox
          key={selectedCase?.case_id}
          tree={(selectedCase && caseTreeFor(report, selectedCase)) || report.judgeTree}
        />
      )}

      {/* Case result / judgments — full-width row for the selected case
          (verdict + per-criterion judgments + failure, with proper room). */}
      {selectedCase && (
        <div className="flex flex-col gap-6">
          <CaseSummary c={selectedCase} />
        </div>
      )}

      {/* Transcript — full-width, at the bottom (raw detail) for the selected
          case + its per-case recording. Selector at the top drives this. */}
      <div className="ao-panel">
        <div className="ao-panel-head">
          <SectionTitle
            icon={<ScrollText size={16} className="text-muted-foreground" />}
            title={<>Transcript{selectedCase ? <> · <span className="font-mono">{selectedCase.name}</span></> : ''}</>}
            hint="full conversation"
          />
          {selectedCase && (
            <span className="ao-panel-sub">
              {selectedCase.events.length} event{selectedCase.events.length !== 1 ? 's' : ''}
              {caseAvg != null && <> · avg TTFT {formatMs(caseAvg)}</>}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-col">
          <div className="max-h-[72vh] overflow-auto p-4">
            {selectedCase ? (
              <EvalTranscript events={selectedCase.events} />
            ) : (
              <div className="py-8 text-center text-sm text-muted-foreground">No cases recorded.</div>
            )}
          </div>
          {selectedCase?.recording_url && (
            <div className="flex items-center gap-2.5 border-t border-border px-4 py-3">
              <AudioLines size={16} className="shrink-0 text-muted-foreground" />
              <AudioPlayer src={selectedCase.recording_url} className="flex-1" durationHint={selectedCase.cost?.call_seconds} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
