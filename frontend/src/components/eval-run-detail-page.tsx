import { useMemo, useState } from 'react'
import { ArrowLeft, ExternalLink, GitBranch, GitCommit } from 'lucide-react'
import { parseAsString, useQueryState } from 'nuqs'
import {
  type ColumnDef,
  type ColumnFiltersState,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { DataTable } from '@/components/data-table/data-table'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { CaseStatusBadge } from '@/components/eval-status-badge'
import { EvalCaseDetailPage } from '@/components/eval-case-detail-page'
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useEvalRun } from '@/lib/observability-hooks'
import type { CaseStatus, EvalCaseRow } from '@/lib/observability-types'

const STATUS_OPTIONS: Array<{ label: string; value: CaseStatus }> = [
  { label: 'Passed', value: 'passed' },
  { label: 'Failed', value: 'failed' },
  { label: 'Errored', value: 'errored' },
  { label: 'Skipped', value: 'skipped' },
]

function SummaryCard({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string | number
  tone?: 'default' | 'good' | 'bad' | 'warn'
}) {
  const toneCls = {
    default: 'text-foreground',
    good: 'text-emerald-600 dark:text-emerald-400',
    bad: 'text-destructive',
    warn: 'text-amber-600 dark:text-amber-400',
  }[tone]
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-xs-500 text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={`mt-1 text-h3-600 font-semibold ${toneCls}`}>{value}</div>
    </div>
  )
}

export const EvalRunDetailPage = ({
  runId,
  onBack,
  onCaseClick,
}: {
  runId: string
  onBack?: () => void
  /** Optional. If provided, row clicks call this (useful when the consumer
   * wants to navigate to a full page). If omitted, the component opens a
   * local drawer instead and syncs the case via `?case=<id>`. */
  onCaseClick?: (caseId: string) => void
}) => {
  const { run, loading, error } = useEvalRun(runId)
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [openCaseId, setOpenCaseId] = useQueryState('case', parseAsString)

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
          <span className="text-s-400 text-muted-foreground max-w-[240px] inline-block truncate">
            {row.original.file ?? '—'}
          </span>
        ),
        meta: { label: 'File' },
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Status" />,
        cell: ({ row }) => <CaseStatusBadge status={row.original.status} />,
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
          <span className="text-s-400">{formatDuration(row.original.duration_ms)}</span>
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
            <span className="text-s-400">
              {judgePass > 0 && (
                <span className="text-emerald-600 dark:text-emerald-400">{judgePass} pass</span>
              )}
              {judgePass > 0 && judgeFail > 0 && <span> · </span>}
              {judgeFail > 0 && (
                <span className="text-destructive">{judgeFail} fail</span>
              )}
            </span>
          )
        },
      },
      {
        id: 'events',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Events" />,
        cell: ({ row }) => (
          <span className="text-s-400 text-muted-foreground">{row.original.events.length}</span>
        ),
      },
    ],
    [],
  )

  const table = useReactTable({
    data: run?.cases ?? [],
    columns,
    state: { columnFilters },
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    getRowId: (row) => row.case_id,
  })

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          <span className="text-s-400">Loading eval run...</span>
        </div>
      </div>
    )
  }

  if (error || !run) {
    return (
      <div className="p-12 text-center text-destructive">
        <p>Failed to load eval run: {error ?? 'not found'}</p>
        {onBack && (
          <Button variant="outline" onClick={onBack} className="mt-4">
            <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back
          </Button>
        )}
      </div>
    )
  }

  const passRate = run.total > 0 ? Math.round((run.passed / run.total) * 100) : 0

  const handleRowClick = (caseId: string) => {
    if (onCaseClick) {
      onCaseClick(caseId)
    } else {
      void setOpenCaseId(caseId)
    }
  }

  return (
    <div className="p-6">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-4 inline-flex items-center gap-1 text-s-400 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to evals
        </button>
      )}

      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <div>
          <h1 className="text-h2-600 font-semibold flex items-center gap-2">
            {run.agent_id ?? <span className="text-muted-foreground">—</span>}
            <Badge variant="outline" className="text-xxs-400">
              {run.framework}
              {run.framework_version && (
                <span className="ml-1 text-muted-foreground">{run.framework_version}</span>
              )}
            </Badge>
          </h1>
          <div className="text-s-400 text-muted-foreground font-mono mt-1">{run.run_id}</div>
        </div>
        <div className="text-right text-s-400 text-muted-foreground">
          <div>Started {formatDate(run.started_at)}</div>
          <div>Duration {formatDuration(run.duration_ms)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-6">
        <SummaryCard label="Pass rate" value={`${passRate}%`} tone={passRate === 100 ? 'good' : 'bad'} />
        <SummaryCard label="Passed" value={run.passed} tone="good" />
        <SummaryCard label="Failed" value={run.failed} tone={run.failed > 0 ? 'bad' : 'default'} />
        <SummaryCard label="Errored" value={run.errored} tone={run.errored > 0 ? 'warn' : 'default'} />
        <SummaryCard label="Skipped" value={run.skipped} />
      </div>

      {run.ci && (
        <div className="mt-6 rounded-lg border bg-card p-4 flex flex-wrap items-center gap-4">
          <span className="text-xs-500 text-muted-foreground uppercase tracking-wide">CI</span>
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
        </div>
      )}

      <div className="mt-8">
        <h2 className="text-h4-600 font-semibold mb-3">
          Cases ({table.getFilteredRowModel().rows.length} of {run.cases.length})
        </h2>
        <DataTable table={table} onRowClick={(row) => handleRowClick(row.original.case_id)}>
          <DataTableToolbar table={table} />
        </DataTable>
      </div>

      {/* Drawer: only used when no external onCaseClick handler is provided. */}
      {!onCaseClick && (
        <Sheet
          open={!!openCaseId}
          onOpenChange={(open) => {
            if (!open) void setOpenCaseId(null)
          }}
        >
          <SheetContent className="w-full sm:max-w-2xl md:max-w-3xl overflow-y-auto p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>Case detail</SheetTitle>
            </SheetHeader>
            {openCaseId && (
              <EvalCaseDetailPage
                runId={runId}
                caseId={openCaseId}
                onBack={() => void setOpenCaseId(null)}
              />
            )}
          </SheetContent>
        </Sheet>
      )}
    </div>
  )
}
