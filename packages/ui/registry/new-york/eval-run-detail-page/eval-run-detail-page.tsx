import { useMemo, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { parseAsString, useQueryState } from 'nuqs'
import { ArrowLeft, ExternalLink, FlaskConical, GitBranch, GitCommit } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { ObsDataTable } from '@/components/data-table/obs-data-table'
import { useDataTable } from '@/hooks/use-data-table'
import { cn } from '@/lib/utils'
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useEvalRun } from '@/lib/observability-hooks'
import type { CaseStatus, EvalCaseRow } from '@/lib/observability-types'
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

function StatCard({
  label,
  value,
  suffix,
  tone = 'default',
  meterPct,
  meterClass,
}: {
  label: string
  value: string | number
  suffix?: string
  tone?: 'default' | 'hero' | 'passed' | 'failed' | 'zero'
  meterPct?: number
  meterClass?: string
}) {
  const valueTone =
    tone === 'hero' || tone === 'failed'
      ? 'text-foreground'
      : tone === 'passed'
        ? 'text-foreground'
        : tone === 'zero'
          ? 'text-muted-foreground'
          : ''
  const cardTone =
    tone === 'hero'
      ? 'bg-gradient-to-b from-[hsl(var(--destructive-bg,0_85%_97%))] to-card border-border'
      : ''
  return (
    <Card className={cn('relative overflow-hidden', cardTone)}>
      <CardHeader className="pb-2">
        <CardTitle className={cn('text-xs-600 uppercase tracking-wide text-muted-foreground', tone === 'hero' && 'text-foreground')}>
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn('text-h1-600 font-semibold tabular-nums flex items-baseline gap-2', valueTone)}>
          {value}
          {suffix && <span className="text-p-500 text-muted-foreground">{suffix}</span>}
        </div>
        {meterPct != null && (
          <div className="absolute left-0 right-0 bottom-0 h-[3px] bg-muted">
            <div
              className={cn('h-full', meterClass)}
              style={{ width: `${Math.max(0, Math.min(100, meterPct))}%` }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
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
    return {
      passRate,
      hasAnyFailure: run.failed > 0 || run.errored > 0,
      passedPct: run.total > 0 ? (run.passed / run.total) * 100 : 0,
      failedPct: run.total > 0 ? (run.failed / run.total) * 100 : 0,
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
        meta: { label: 'Name', placeholder: 'Search name', variant: 'text' },
      },
      {
        id: 'file',
        accessorKey: 'file',
        header: ({ column }) => <DataTableColumnHeader column={column} label="File" />,
        cell: ({ row }) => (
          <span className="font-mono text-xs-400 text-muted-foreground">
            {row.original.file ?? '—'}
          </span>
        ),
        meta: { label: 'File' },
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Status" />,
        cell: ({ row }) => <StatusChip status={row.original.status} />,
        enableColumnFilter: true,
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
        meta: { label: 'Duration' },
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
                <span className="text-foreground text-xs-600">✓ {judgePass} pass</span>
              )}
              {judgePass > 0 && judgeFail > 0 && (
                <span className="text-muted-foreground">·</span>
              )}
              {judgeFail > 0 && (
                <Badge
                  variant="outline"
                  className="text-xxs-600 text-foreground border-border uppercase tracking-wider"
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
      <div className="flex flex-col gap-5 p-6" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[110px] rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-[300px] w-full rounded-xl" />
      </div>
    )
  }

  if (error || !run || !stats) {
    return (
      <div className="p-12 text-center text-foreground">
        <p>Failed to load eval run: {error ?? 'not found'}</p>
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="mt-4">
            <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="p-6 flex flex-col gap-5 relative">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-s-500 text-muted-foreground hover:text-foreground transition-colors bg-transparent border-none p-0 w-fit cursor-pointer"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to evals
        </button>
      )}

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <h1 className="text-h2-600 font-semibold m-0">
              {run.agent_id ?? <span className="text-muted-foreground">—</span>}
            </h1>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted border text-xs-500">
              <FlaskConical className="h-3 w-3 text-muted-foreground" />
              {run.framework}
              {run.framework_version && (
                <span className="text-muted-foreground font-mono text-[11px]">
                  {run.framework_version}
                </span>
              )}
            </span>
          </div>
          <div className="font-mono text-xs-400 text-muted-foreground">{run.run_id}</div>
        </div>
        <div className="text-right text-s-400 text-muted-foreground">
          <b className="block text-foreground text-s-600">
            Started {formatDate(run.started_at)}
          </b>
          <span>Duration {formatDuration(run.duration_ms)}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard
          label="Pass rate"
          value={stats.passRate}
          suffix="%"
          tone={stats.hasAnyFailure ? 'hero' : 'passed'}
          meterPct={stats.passRate}
          meterClass={
            stats.passRate === 100
              ? 'bg-foreground'
              : 'bg-foreground'
          }
        />
        <StatCard
          label="Passed"
          value={run.passed}
          tone="passed"
          meterPct={stats.passedPct}
          meterClass="bg-foreground"
        />
        <StatCard
          label="Failed"
          value={run.failed}
          tone={run.failed > 0 ? 'failed' : 'zero'}
          meterPct={stats.failedPct}
          meterClass="bg-foreground"
        />
        <StatCard
          label="Errored"
          value={run.errored}
          tone={run.errored > 0 ? 'failed' : 'zero'}
        />
        <StatCard label="Skipped" value={run.skipped} tone="zero" />
      </div>

      {run.ci && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-4 py-3">
            <span className="text-xs-600 text-muted-foreground uppercase tracking-wider">CI</span>
            {run.ci.provider && (
              <span className="text-s-400 capitalize">{String(run.ci.provider)}</span>
            )}
            {run.ci.git_branch && (
              <span className="inline-flex items-center gap-1 text-s-400">
                <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                {String(run.ci.git_branch)}
              </span>
            )}
            {run.ci.git_sha && (
              <span className="inline-flex items-center gap-1 text-s-400 font-mono">
                <GitCommit className="h-3.5 w-3.5 text-muted-foreground" />
                {String(run.ci.git_sha).slice(0, 7)}
              </span>
            )}
            {run.ci.run_url && (
              <a
                href={String(run.ci.run_url)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-s-400 text-primary hover:underline"
              >
                View run <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {run.ci.commit_message && (
              <span className="text-s-400 text-muted-foreground italic truncate max-w-[40ch]">
                "{String(run.ci.commit_message)}"
              </span>
            )}
          </CardContent>
        </Card>
      )}

      <div>
        <h2 className="text-h4-600 font-semibold mb-3">
          Cases{' '}
          <span className="text-muted-foreground text-s-400">
            ({table.getFilteredRowModel().rows.length} of {run.cases.length})
          </span>
        </h2>
        <ObsDataTable
          table={table}
          toolbar={<DataTableToolbar table={table} />}
          onRowClick={(row) => handleRowClick(row.original.case_id)}
        />
      </div>

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
