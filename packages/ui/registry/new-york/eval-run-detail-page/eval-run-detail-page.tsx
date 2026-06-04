import { useMemo, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { parseAsString, useQueryState } from 'nuqs'
import {
  AlertTriangle,
  AudioLines,
  ArrowLeft,
  Bot,
  ExternalLink,
  FlaskConical,
  GitBranch,
  GitCommit,
  Layers,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { ObsDataTable } from '@/components/data-table/obs-data-table'
import { useDataTable } from '@/components/data-table/use-data-table'
import { cn } from '@/lib/utils'
import { formatDate, formatDuration, formatMs } from '@/lib/observability-format'
import { useEvalRun } from '@/lib/observability-hooks'
import type { CaseStatus, EvalCaseRow, RunEvent, RunEventMessage } from '@/lib/observability-types'
import { EvalCaseDetailPage } from '@/components/eval-case-detail-page'

const STATUS_OPTIONS: Array<{ label: string; value: CaseStatus }> = [
  { label: 'Passed', value: 'passed' },
  { label: 'Failed', value: 'failed' },
  { label: 'Errored', value: 'errored' },
  { label: 'Skipped', value: 'skipped' },
]

/** Duration thresholds for eval cases: good ≤ 2s, okay 2–5s, bad > 5s.
 * Wider than voice latencies since eval cases often involve multi-turn
 * conversations or slow fixtures. */
function durationToneClass(ms: number | null): string {
  if (ms == null) return ''
  if (ms <= 2000) return 'text-[hsl(var(--success-fg,var(--success)))]'
  if (ms <= 5000) return 'text-[hsl(var(--warning-fg,var(--warning)))]'
  return 'text-[hsl(var(--destructive))]'
}

/** Maps a case status to its `ao-badge` tone modifier. */
const STATUS_BADGE_TONE: Record<CaseStatus, string> = {
  passed: 'is-success',
  failed: 'is-danger',
  errored: 'is-warning',
  skipped: 'is-neutral',
}

/** Mean of `metrics.llm_node_ttft` (seconds → ms) across all `message`
 * events with metrics. Returns null when no samples exist. */
function caseAvgTtftMs(events: RunEvent[]): number | null {
  const ttfts: number[] = []
  for (const ev of events) {
    if (ev.type !== 'message') continue
    const ttft = (ev as RunEventMessage).metrics?.llm_node_ttft
    if (typeof ttft === 'number') ttfts.push(ttft * 1000)
  }
  return ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null
}

function StatusChip({ status }: { status: CaseStatus }) {
  return (
    <span className={cn('ao-badge ao-badge--dot capitalize', STATUS_BADGE_TONE[status])}>
      {status}
    </span>
  )
}

type StatTone = 'good' | 'warn' | 'bad' | 'zero' | 'default'

/** Maps a metric tone to the shared `ao-stat` tone modifier. `zero` mutes
 * the tile (no semantic color) so 0 counts don't compete with real signals. */
function statToneClass(tone: StatTone): string {
  switch (tone) {
    case 'good':
      return 'is-good'
    case 'warn':
      return 'is-warn'
    case 'bad':
      return 'is-bad'
    default:
      return ''
  }
}

/** KPI tile built on the shared `ao-stat` language. `feature` adds the
 * accent gradient edge for the headline metric. A thin token-tinted meter
 * can pin to the bottom of the tile. */
function StatCard({
  label,
  value,
  suffix,
  tone = 'default',
  meterPct,
  feature,
  icon,
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
    tone === 'good'
      ? 'bg-[hsl(var(--success-fg,var(--success)))]'
      : tone === 'warn'
        ? 'bg-[hsl(var(--warning-fg,var(--warning)))]'
        : tone === 'bad'
          ? 'bg-[hsl(var(--destructive))]'
          : tone === 'zero'
            ? 'bg-muted-foreground/40'
            : 'bg-foreground'
  return (
    <div className={cn('ao-stat relative overflow-hidden', feature && 'ao-stat--feature', statToneClass(tone))}>
      <div className="ao-stat-label">
        {icon}
        {label}
      </div>
      <div className={cn('ao-stat-value', tone === 'zero' && 'text-muted-foreground')}>
        {value}
        {suffix && <span className="unit">{suffix}</span>}
      </div>
      {meterPct != null && (
        <div className="absolute left-0 right-0 bottom-0 h-[3px] bg-muted">
          <div
            className={cn('h-full transition-[width]', meterClass)}
            style={{ width: `${Math.max(0, Math.min(100, meterPct))}%` }}
          />
        </div>
      )}
    </div>
  )
}

/** Pass-rate card tone matches the session-detail latency scale:
 * 100% good, ≥ 70% warn, below bad. */
function passRateTone(pct: number): StatTone {
  if (pct >= 100) return 'good'
  if (pct >= 70) return 'warn'
  return 'bad'
}

export const EvalRunDetailPage = ({
  runId,
  onBack,
  onCaseClick,
}: {
  runId: string
  onBack?: () => void
  onCaseClick?: (caseId: string) => void
}) => {
  const { run, loading, error } = useEvalRun(runId)
  const [openCaseId, setOpenCaseId] = useQueryState('case', parseAsString)
  const [localOpenCaseId, setLocalOpenCaseId] = useState<string | null>(null)
  const drawerCaseId = openCaseId ?? localOpenCaseId

  const handleRowClick = (caseId: string) => {
    if (onCaseClick) onCaseClick(caseId)
    else if (openCaseId !== undefined) void setOpenCaseId(caseId)
    else setLocalOpenCaseId(caseId)
  }
  const closeDrawer = () => {
    if (openCaseId !== null) void setOpenCaseId(null)
    setLocalOpenCaseId(null)
  }

  const stats = useMemo(() => {
    if (!run) return null
    const passRate = run.total > 0 ? Math.round((run.passed / run.total) * 100) : 0
    // Flat-average TTFT across every message-with-metrics event in every
    // case, so the headline number reflects typical LLM latency rather
    // than weighting each case equally regardless of turn count.
    const allTtfts: number[] = []
    for (const c of run.cases) {
      for (const ev of c.events) {
        if (ev.type !== 'message') continue
        const ttft = (ev as RunEventMessage).metrics?.llm_node_ttft
        if (typeof ttft === 'number') allTtfts.push(ttft * 1000)
      }
    }
    const avgTtftMs =
      allTtfts.length ? allTtfts.reduce((a, b) => a + b, 0) / allTtfts.length : null
    return {
      passRate,
      hasAnyFailure: run.failed > 0 || run.errored > 0,
      passedPct: run.total > 0 ? (run.passed / run.total) * 100 : 0,
      failedPct: run.total > 0 ? (run.failed / run.total) * 100 : 0,
      avgTtftMs,
    }
  }, [run])

  const columns = useMemo<ColumnDef<EvalCaseRow>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <span className="font-mono text-s-400">{row.original.name}</span>
        ),
        enableColumnFilter: true,
        enableSorting: false,
        meta: { label: 'Name', placeholder: 'Search name', variant: 'text' },
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Status" />,
        cell: ({ row }) => <StatusChip status={row.original.status} />,
        enableColumnFilter: true,
        enableSorting: false,
        meta: {
          label: 'Status',
          variant: 'multiSelect',
          options: STATUS_OPTIONS,
        },
        filterFn: (row, id, value) => {
          if (!Array.isArray(value) || value.length === 0) return true
          return value.includes(row.getValue(id))
        },
      },
      {
        id: 'duration_ms',
        accessorKey: 'duration_ms',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Duration" />,
        cell: ({ row }) => (
          <span
            className={cn(
              'font-mono text-s-400 tabular-nums',
              durationToneClass(row.original.duration_ms),
            )}
          >
            {formatDuration(row.original.duration_ms)}
          </span>
        ),
        enableSorting: false,
        meta: { label: 'Duration' },
      },
      {
        id: 'avg_ttft_ms',
        accessorFn: (row) => caseAvgTtftMs(row.events),
        header: ({ column }) => <DataTableColumnHeader column={column} label="Avg TTFT" />,
        cell: ({ getValue }) => {
          const ms = getValue<number | null>()
          return (
            <span className="font-mono text-s-400 tabular-nums text-muted-foreground">
              {ms != null ? formatMs(ms) : '—'}
            </span>
          )
        },
        enableSorting: false,
        meta: { label: 'Avg TTFT' },
      },
      {
        id: 'judgments',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Judgments" />,
        cell: ({ row }) => {
          const c = row.original
          const judgePass = c.judgments.filter((j) => j.verdict === 'pass').length
          const judgeFail = c.judgments.filter((j) => j.verdict === 'fail').length
          if (c.judgments.length === 0) return <span className="text-muted-foreground">—</span>
          return (
            <span className="inline-flex items-center gap-2 text-s-400">
              {judgePass > 0 && (
                <span className="text-[hsl(var(--success-fg,var(--success)))] text-xs-600">
                  ✓ {judgePass} pass
                </span>
              )}
              {judgePass > 0 && judgeFail > 0 && (
                <span className="text-muted-foreground">·</span>
              )}
              {judgeFail > 0 && (
                <Badge
                  variant="outline"
                  className="text-xxs-600 text-[hsl(var(--destructive))] border-[hsl(var(--destructive-border))] bg-[hsl(var(--destructive-bg))] uppercase tracking-wider"
                >
                  {judgeFail} fail
                </Badge>
              )}
            </span>
          )
        },
      },
      {
        id: 'events',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Events" />,
        cell: ({ row }) => (
          <span className="text-s-400 tabular-nums text-muted-foreground">
            {row.original.events.length}
          </span>
        ),
      },
    ],
    [],
  )

  const { table } = useDataTable({
    data: run?.cases ?? [],
    columns,
    pageCount: 1,
    initialState: { pagination: { pageIndex: 0, pageSize: 20 } },
    getRowId: (row) => row.case_id,
  })

  if (loading) {
    return (
      <div className="p-6 flex flex-col gap-6" aria-busy="true">
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
            <div className="ao-skeleton ao-skeleton--line" style={{ width: '90%' }} />
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
            className="inline-flex items-center gap-1.5 text-s-500 text-muted-foreground hover:text-foreground transition-colors bg-transparent border-none p-0 w-fit cursor-pointer mb-5"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to evals
          </button>
        )}
        <div className="ao-empty">
          <div className="ao-empty-icon">
            <AlertTriangle />
          </div>
          <div className="ao-empty-title">Couldn't load this eval run</div>
          <div className="ao-empty-text">{error ?? 'The run was not found, or has been deleted.'}</div>
          {onBack && (
            <div className="ao-empty-actions">
              <button type="button" className="ao-btn ao-btn--outline" onClick={onBack}>
                <ArrowLeft className="h-3.5 w-3.5" /> Back to evals
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  const filteredCount = table.getFilteredRowModel().rows.length

  return (
    <div className="p-6 flex flex-col gap-6 relative">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-s-500 text-muted-foreground hover:text-foreground transition-colors bg-transparent border-none p-0 w-fit cursor-pointer ao-reveal"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to evals
        </button>
      )}

      <header className="ao-hero ao-reveal ao-reveal-1">
        <div className="min-w-0">
          <div className="ao-hero-eyebrow">
            <FlaskConical /> Eval run
          </div>
          <h1 className="ao-hero-title truncate">
            {run.agent_id ?? <span className="text-muted-foreground">Unnamed agent</span>}
          </h1>
          <div className="flex items-center gap-2 flex-wrap mt-2">
            {run.framework && (
              <span className="ao-badge is-neutral">
                <Bot className="h-3 w-3 shrink-0" />
                {run.framework}
                {run.framework_version && (
                  <span className="ao-mono ml-0.5">{run.framework_version}</span>
                )}
              </span>
            )}
            <span className="ao-badge is-neutral">
              <FlaskConical className="h-3 w-3 shrink-0" />
              {run.testing_framework}
              {run.testing_framework_version && (
                <span className="ao-mono ml-0.5">{run.testing_framework_version}</span>
              )}
            </span>
            <span className="ao-mono">{run.run_id}</span>
          </div>
        </div>
        <div className="ao-hero-actions">
          <div className="text-right text-s-400 text-muted-foreground">
            <b className="block text-foreground text-s-600">Started {formatDate(run.started_at)}</b>
            <span className="ao-mono">Duration {formatDuration(run.duration_ms)}</span>
          </div>
        </div>
      </header>

      <div className="ao-stat-row ao-stagger">
        <StatCard
          label="Pass rate"
          value={stats.passRate}
          suffix="%"
          tone={passRateTone(stats.passRate)}
          meterPct={stats.passRate}
          feature
        />
        <StatCard
          label="Passed"
          value={run.passed}
          tone={run.passed > 0 ? 'good' : 'zero'}
          meterPct={stats.passedPct}
        />
        <StatCard
          label="Failed"
          value={run.failed}
          tone={run.failed > 0 ? 'bad' : 'zero'}
          meterPct={stats.failedPct}
        />
        <StatCard
          label="Errored"
          value={run.errored}
          tone={run.errored > 0 ? 'bad' : 'zero'}
        />
        <StatCard
          label="Skipped"
          value={run.skipped}
          tone={run.skipped > 0 ? 'warn' : 'zero'}
        />
        <StatCard
          label="Avg TTFT"
          value={stats.avgTtftMs != null ? formatMs(stats.avgTtftMs) : '—'}
          tone={stats.avgTtftMs == null ? 'zero' : 'default'}
        />
      </div>

      {run.ci && (
        <section className="ao-panel ao-reveal ao-reveal-2">
          <div className="ao-panel-head">
            <div className="ao-panel-title">
              <GitBranch /> Continuous integration
            </div>
            {run.ci.run_url && (
              <a
                href={String(run.ci.run_url)}
                target="_blank"
                rel="noreferrer"
                className="ao-btn ao-btn--ghost ao-btn--sm"
              >
                View run <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <div className="ao-panel-body flex flex-wrap items-center gap-x-6 gap-y-2.5">
            {run.ci.provider && (
              <div className="flex flex-col gap-0.5">
                <span className="ao-section-label">Provider</span>
                <span className="text-s-500 capitalize">{String(run.ci.provider)}</span>
              </div>
            )}
            {run.ci.git_branch && (
              <div className="flex flex-col gap-0.5">
                <span className="ao-section-label">Branch</span>
                <span className="inline-flex items-center gap-1.5 text-s-500">
                  <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                  {String(run.ci.git_branch)}
                </span>
              </div>
            )}
            {run.ci.git_sha && (
              <div className="flex flex-col gap-0.5">
                <span className="ao-section-label">Commit</span>
                <span className="inline-flex items-center gap-1.5 ao-mono">
                  <GitCommit className="h-3.5 w-3.5 text-muted-foreground" />
                  {String(run.ci.git_sha).slice(0, 7)}
                </span>
              </div>
            )}
            {run.ci.commit_message && (
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="ao-section-label">Message</span>
                <span className="text-s-400 text-muted-foreground italic truncate max-w-[44ch]">
                  "{String(run.ci.commit_message)}"
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      {run.cases.some((c) => c.recording_url) && (
        <section className="ao-panel ao-reveal ao-reveal-3">
          <div className="ao-panel-head">
            <div>
              <div className="ao-panel-title"><AudioLines /> Recordings</div>
              <div className="ao-panel-sub">
                {run.cases.filter((c) => c.recording_url).length} call{run.cases.filter((c) => c.recording_url).length === 1 ? '' : 's'} recorded
              </div>
            </div>
          </div>
          <div className="ao-panel-body flex flex-col gap-3">
            {run.cases.filter((c) => c.recording_url).map((c) => (
              <div key={c.case_id} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                <button
                  type="button"
                  onClick={() => handleRowClick(c.case_id)}
                  className="ao-mono text-s-500 text-left text-foreground hover:text-[hsl(var(--link))] sm:w-48 sm:shrink-0 truncate"
                >
                  {c.name}
                </button>
                <audio controls preload="none" src={c.recording_url!} className="w-full flex-1" />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="ao-reveal ao-reveal-3 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="ao-panel-title">
            <Layers /> Cases
            <span className="ao-badge is-neutral ml-1">
              {filteredCount} of {run.cases.length}
            </span>
          </div>
        </div>
        <ObsDataTable
          table={table}
          toolbar={<DataTableToolbar table={table} />}
          onRowClick={(row) => handleRowClick(row.original.case_id)}
        />
      </section>

      {!onCaseClick && (
        <Sheet
          open={!!drawerCaseId}
          onOpenChange={(open) => {
            if (!open) closeDrawer()
          }}
        >
          <SheetContent
            className="w-full sm:max-w-2xl md:max-w-3xl overflow-y-auto p-0"
            showCloseButton={false}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Case detail</SheetTitle>
            </SheetHeader>
            {drawerCaseId && (
              <EvalCaseDetailPage
                runId={runId}
                caseId={drawerCaseId}
                onBack={closeDrawer}
              />
            )}
          </SheetContent>
        </Sheet>
      )}
    </div>
  )
}
