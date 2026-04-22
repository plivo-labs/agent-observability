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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { ObsDataTable } from '@/components/data-table/obs-data-table'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { EvalCaseDetailPage } from '@/components/eval-case-detail-page'
import { FrameworkPill, StatusChip } from '@/components/obs-cells'
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useEvalRun } from '@/lib/observability-hooks'
import type { CaseStatus, EvalCaseRow } from '@/lib/observability-types'

const STATUS_OPTIONS: Array<{ label: string; value: CaseStatus }> = [
  { label: 'Passed', value: 'passed' },
  { label: 'Failed', value: 'failed' },
  { label: 'Errored', value: 'errored' },
  { label: 'Skipped', value: 'skipped' },
]

/**
 * One of the five `.eval-stat` tiles on the run header. The pass-rate tile
 * gets the `hero` treatment (red gradient) when the rate is below 100;
 * passed/failed carry their own tint; errored/skipped go quiet when zero.
 */
function EvalStat({
  label,
  value,
  suffix,
  variant = 'default',
  meterPct,
  meterColor,
}: {
  label: string
  value: string | number
  suffix?: string
  variant?: 'default' | 'hero' | 'passed' | 'failed' | 'zero'
  meterPct?: number
  meterColor?: string
}) {
  return (
    <div className={`eval-stat ${variant}`}>
      <div className="hd">{label}</div>
      <div className="val">
        {value}
        {suffix && <span className="suffix">{suffix}</span>}
      </div>
      {meterPct != null && (
        <div className="eval-meter">
          <i style={{ width: `${Math.max(0, Math.min(100, meterPct))}%`, background: meterColor }} />
        </div>
      )}
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
        cell: ({ row }) => <span className="mono">{row.original.name}</span>,
        enableColumnFilter: true,
        meta: { label: 'Name', placeholder: 'Search name', variant: 'text' },
      },
      {
        id: 'file',
        accessorKey: 'file',
        header: ({ column }) => <DataTableColumnHeader column={column} label="File" />,
        cell: ({ row }) => (
          <span className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
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
        cell: ({ row }) => <span className="mono tnum">{formatDuration(row.original.duration_ms)}</span>,
        meta: { label: 'Duration' },
      },
      {
        id: 'judgments',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Judgments" />,
        cell: ({ row }) => {
          const c = row.original
          const judgePass = c.judgments.filter((j) => j.verdict === 'pass').length
          const judgeFail = c.judgments.filter((j) => j.verdict === 'fail').length
          if (c.judgments.length === 0) return <span className="muted">—</span>
          return (
            <span style={{ font: 'var(--text-s-400)' }}>
              {judgePass > 0 && <span className="judg-pass">✓ {judgePass} pass</span>}
              {judgePass > 0 && judgeFail > 0 && (
                <span style={{ margin: '0 6px', color: 'hsl(var(--tertiary))' }}>·</span>
              )}
              {judgeFail > 0 && (
                <span style={{ color: 'hsl(var(--destructive))', font: 'var(--text-xs-600)' }}>
                  {judgeFail} fail
                </span>
              )}
            </span>
          )
        },
      },
      {
        id: 'events',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Events" />,
        cell: ({ row }) => <span className="tnum muted">{row.original.events.length}</span>,
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <div className="eval-stats">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[110px] rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-[300px] w-full rounded-xl" />
      </div>
    )
  }

  if (error || !run) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: 'hsl(var(--destructive))' }}>
        <p>Failed to load eval run: {error ?? 'not found'}</p>
        {onBack && (
          <button type="button" className="obs-back" onClick={onBack} style={{ marginTop: 16 }}>
            <ArrowLeft size={14} /> Back
          </button>
        )}
      </div>
    )
  }

  const passRate = run.total > 0 ? Math.round((run.passed / run.total) * 100) : 0
  const hasAnyFailure = run.failed > 0 || run.errored > 0
  const passMeterColor = passRate === 100 ? 'hsl(var(--success))' : 'hsl(var(--destructive))'

  const handleRowClick = (caseId: string) => {
    if (onCaseClick) onCaseClick(caseId)
    else void setOpenCaseId(caseId)
  }

  return (
    <div style={{ position: 'relative' }}>
      {onBack && (
        <button type="button" className="obs-back" onClick={onBack}>
          <ArrowLeft size={14} /> Back to evals
        </button>
      )}

      <div className="eval-head">
        <div className="left">
          <div className="title-row">
            <h1>{run.agent_id ?? <span className="muted">—</span>}</h1>
            <FrameworkPill name={run.framework} version={run.framework_version} />
          </div>
          <div className="id">{run.run_id}</div>
        </div>
        <div className="right">
          <b>Started {formatDate(run.started_at)}</b>
          <span>Duration {formatDuration(run.duration_ms)}</span>
        </div>
      </div>

      <div className="eval-stats">
        <EvalStat
          label="Pass rate"
          value={passRate}
          suffix="%"
          variant={hasAnyFailure ? 'hero' : 'passed'}
          meterPct={passRate}
          meterColor={passMeterColor}
        />
        <EvalStat
          label="Passed"
          value={run.passed}
          variant="passed"
          meterPct={run.total > 0 ? (run.passed / run.total) * 100 : 0}
          meterColor="hsl(var(--success))"
        />
        <EvalStat
          label="Failed"
          value={run.failed}
          variant={run.failed > 0 ? 'failed' : 'zero'}
          meterPct={run.total > 0 ? (run.failed / run.total) * 100 : 0}
          meterColor="hsl(var(--destructive))"
        />
        <EvalStat
          label="Errored"
          value={run.errored}
          variant={run.errored > 0 ? 'failed' : 'zero'}
        />
        <EvalStat label="Skipped" value={run.skipped} variant="zero" />
      </div>

      {run.ci && (
        <div
          style={{
            marginTop: 16,
            background: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: 12,
            padding: '12px 16px',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <span
            style={{
              font: 'var(--text-xs-600)',
              color: 'hsl(var(--tertiary))',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            CI
          </span>
          {run.ci.provider && (
            <span style={{ font: 'var(--text-s-400)', textTransform: 'capitalize' }}>
              {String(run.ci.provider)}
            </span>
          )}
          {run.ci.git_branch && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, font: 'var(--text-s-400)' }}>
              <GitBranch size={13} style={{ color: 'hsl(var(--tertiary))' }} />
              {String(run.ci.git_branch)}
            </span>
          )}
          {run.ci.git_sha && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                font: 'var(--text-s-400)',
                fontFamily: 'var(--mono)',
              }}
            >
              <GitCommit size={13} style={{ color: 'hsl(var(--tertiary))' }} />
              {String(run.ci.git_sha).slice(0, 7)}
            </span>
          )}
          {run.ci.run_url && (
            <a
              href={String(run.ci.run_url)}
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                font: 'var(--text-s-400)',
                color: 'hsl(var(--link))',
              }}
            >
              View run <ExternalLink size={12} />
            </a>
          )}
          {run.ci.commit_message && (
            <span
              style={{
                font: 'var(--text-s-400)',
                color: 'hsl(var(--secondary))',
                fontStyle: 'italic',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '40ch',
              }}
            >
              "{String(run.ci.commit_message)}"
            </span>
          )}
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <h2 style={{ font: 'var(--text-h4-600)', margin: '0 0 12px' }}>
          Cases{' '}
          <span style={{ color: 'hsl(var(--tertiary))', font: 'var(--text-s-400)' }}>
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
          open={!!openCaseId}
          onOpenChange={(open) => {
            if (!open) void setOpenCaseId(null)
          }}
        >
          <SheetContent className="w-full sm:max-w-2xl md:max-w-3xl overflow-y-auto p-0" showCloseButton={false}>
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
