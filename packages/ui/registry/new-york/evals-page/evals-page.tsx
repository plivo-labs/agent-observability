import { useMemo } from 'react'
import { parseAsArrayOf, parseAsInteger, parseAsString, useQueryState } from 'nuqs'
import type { ColumnDef } from '@tanstack/react-table'
import { FlaskConical } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { ObsDataTable } from '@/components/data-table/obs-data-table'
import { useDataTable } from '@/hooks/use-data-table'
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useEvalRuns } from '@/lib/observability-hooks'
import type { EvalRunRow } from '@/lib/observability-types'

const FRAMEWORK_OPTIONS = [
  { label: 'pytest', value: 'pytest' },
  { label: 'vitest', value: 'vitest' },
]

function PassRateBar({ passed, total }: { passed: number; total: number }) {
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <span className="font-mono text-xs-600 tabular-nums w-10">{pct}%</span>
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden max-w-[90px]">
        <div className="h-full bg-foreground" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function FrameworkBadge({ name, version }: { name: string; version: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted border text-xs-500">
      <FlaskConical className="h-3 w-3 text-muted-foreground" />
      {name}
      {version && <span className="text-muted-foreground font-mono text-[11px]">{version}</span>}
    </span>
  )
}

export const EvalsPage = ({ onRunClick }: { onRunClick?: (runId: string) => void }) => {
  const [page] = useQueryState('page', parseAsInteger.withDefault(1))
  const [perPage] = useQueryState('perPage', parseAsInteger.withDefault(10))
  const [agentId] = useQueryState('agent_id', parseAsString.withDefault(''))
  const [accountId] = useQueryState('account_id', parseAsString.withDefault(''))
  const [framework] = useQueryState(
    'framework',
    parseAsArrayOf(parseAsString, ',').withDefault([]),
  )
  const [startedAt] = useQueryState(
    'started_at',
    parseAsArrayOf(parseAsString, ',').withDefault([]),
  )
  const startedDay = useMemo(() => {
    const v = startedAt[0]
    if (!v) return undefined
    const d = new Date(Number(v))
    return Number.isNaN(d.getTime()) ? undefined : d
  }, [startedAt])
  const startedFromIso = useMemo(() => startedDay?.toISOString(), [startedDay])
  const startedToIso = useMemo(() => {
    if (!startedDay) return undefined
    const end = new Date(startedDay)
    end.setHours(23, 59, 59, 999)
    return end.toISOString()
  }, [startedDay])

  const { runs, meta, loading, error } = useEvalRuns(
    Math.min(perPage, 20),
    (page - 1) * Math.min(perPage, 20),
    {
      agentId: agentId || undefined,
      accountId: accountId || undefined,
      framework: framework.length ? framework : undefined,
      startedFrom: startedFromIso,
      startedTo: startedToIso,
    },
  )

  const columns = useMemo<ColumnDef<EvalRunRow>[]>(
    () => [
      {
        id: 'run_id',
        accessorKey: 'run_id',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Run" />,
        cell: ({ row }) => (
          <span className="font-mono text-s-400">{row.original.run_id.slice(0, 8)}</span>
        ),
        enableSorting: false,
        meta: { label: 'Run' },
      },
      {
        id: 'agent_id',
        accessorKey: 'agent_id',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Agent" />,
        cell: ({ row }) =>
          row.original.agent_id ? (
            <span className="text-s-400">{row.original.agent_id}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        enableSorting: false,
        enableColumnFilter: true,
        meta: { label: 'Agent', placeholder: 'Filter by agent', variant: 'text' },
      },
      {
        id: 'framework',
        accessorKey: 'framework',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Framework" />,
        cell: ({ row }) => (
          <FrameworkBadge
            name={row.original.framework}
            version={row.original.framework_version}
          />
        ),
        enableSorting: false,
        enableColumnFilter: true,
        meta: {
          label: 'Framework',
          variant: 'multiSelect',
          options: FRAMEWORK_OPTIONS,
        },
      },
      {
        id: 'account_id',
        accessorKey: 'account_id',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Account" />,
        cell: ({ row }) =>
          row.original.account_id ? (
            <span className="font-mono text-s-400 text-muted-foreground max-w-[140px] truncate inline-block">
              {row.original.account_id}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        enableSorting: false,
        enableColumnFilter: true,
        meta: { label: 'Account', placeholder: 'Filter by account', variant: 'text' },
      },
      {
        id: 'pass_rate',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Pass rate" />,
        cell: ({ row }) => {
          const r = row.original
          const failed = r.failed + r.errored
          return (
            <div className="flex items-center gap-2">
              <PassRateBar passed={r.passed} total={r.total} />
              {failed > 0 && (
                <Badge variant="outline" className="text-xxs-600 uppercase tracking-wider">
                  {failed} fail
                </Badge>
              )}
            </div>
          )
        },
        enableSorting: false,
      },
      {
        id: 'total',
        accessorKey: 'total',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Cases" />,
        cell: ({ row }) => <span className="text-s-400 tabular-nums">{row.original.total}</span>,
        enableSorting: false,
        meta: { label: 'Cases' },
      },
      {
        id: 'duration_ms',
        accessorKey: 'duration_ms',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Duration" />,
        cell: ({ row }) => (
          <span className="font-mono text-s-400 tabular-nums">
            {formatDuration(row.original.duration_ms)}
          </span>
        ),
        enableSorting: false,
        meta: { label: 'Duration' },
      },
      {
        id: 'started_at',
        accessorKey: 'started_at',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Started" />,
        cell: ({ row }) => (
          <span className="text-s-400 text-muted-foreground whitespace-nowrap">
            {formatDate(row.original.started_at)}
          </span>
        ),
        enableSorting: false,
        enableColumnFilter: true,
        meta: { label: 'Started', variant: 'date' },
      },
      {
        id: 'commit',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Commit" />,
        cell: ({ row }) => (
          <span className="font-mono text-s-400 text-muted-foreground">
            {row.original.ci?.git_sha ? String(row.original.ci.git_sha).slice(0, 7) : '—'}
          </span>
        ),
        enableSorting: false,
      },
    ],
    [],
  )

  const totalCount = meta.total_count
  const pageCount = Math.max(1, Math.ceil(totalCount / perPage))

  const { table } = useDataTable({
    data: runs,
    columns,
    pageCount,
    initialState: { pagination: { pageIndex: 0, pageSize: 10 } },
    getRowId: (row) => row.run_id,
  })

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-h2-600 font-semibold">Evals</h1>
        <span className="text-s-400 text-muted-foreground">{totalCount} total</span>
      </div>

      {error && (
        <div
          role="alert"
          className="border border-border bg-muted text-foreground px-4 py-3 rounded-md mb-3 text-s-400"
        >
          Failed to load eval runs: {error}
        </div>
      )}

      <ObsDataTable
        table={table}
        toolbar={<DataTableToolbar table={table} />}
        onRowClick={(row) => onRunClick?.(row.original.run_id)}
        totalRowCount={totalCount}
        loading={loading}
      />
    </div>
  )
}
