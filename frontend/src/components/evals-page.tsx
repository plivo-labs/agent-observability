import { useMemo } from 'react'
import { parseAsArrayOf, parseAsInteger, parseAsString, useQueryState } from 'nuqs'
import type { ColumnDef } from '@tanstack/react-table'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/data-table/data-table'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { useDataTable } from '@/hooks/use-data-table'
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useEvalRuns } from '@/lib/observability-hooks'
import type { EvalRunRow } from '@/lib/observability-types'

const FRAMEWORK_OPTIONS = [
  { label: 'pytest', value: 'pytest' },
  { label: 'vitest', value: 'vitest' },
]

function PassRateCell({ run }: { run: EvalRunRow }) {
  const { total, passed, failed, errored, skipped } = run
  const rate = total > 0 ? Math.round((passed / total) * 100) : 0
  const anyFailed = failed > 0 || errored > 0
  return (
    <div className="flex items-center gap-2">
      <span
        className={
          anyFailed
            ? 'text-destructive font-medium'
            : rate === 100
              ? 'text-emerald-600 dark:text-emerald-400 font-medium'
              : 'text-s-400'
        }
      >
        {rate}%
      </span>
      <span className="text-xs-400 text-muted-foreground whitespace-nowrap">
        {passed}/{total}
        {failed > 0 && <span className="text-destructive ml-1">· {failed} failed</span>}
        {errored > 0 && <span className="text-destructive ml-1">· {errored} errored</span>}
        {skipped > 0 && <span className="ml-1">· {skipped} skipped</span>}
      </span>
    </div>
  )
}

export const EvalsPage = ({ onRunClick }: { onRunClick?: (runId: string) => void }) => {
  // URL-synced state — shared with the DataTable via nuqs. The column ids
  // below (`framework`, `agent_id`, `account_id`) are the URL keys the table
  // itself writes when users change filters; we just read them here to drive
  // the server fetch.
  const [page] = useQueryState('page', parseAsInteger.withDefault(1))
  const [perPage] = useQueryState('perPage', parseAsInteger.withDefault(10))
  const [framework] = useQueryState(
    'framework',
    parseAsArrayOf(parseAsString, ',').withDefault([]),
  )
  const [agentId] = useQueryState('agent_id', parseAsString.withDefault(''))
  const [accountId] = useQueryState('account_id', parseAsString.withDefault(''))

  const { runs, meta, loading, error } = useEvalRuns(
    Math.min(perPage, 20),
    (page - 1) * Math.min(perPage, 20),
    {
      agentId: agentId || undefined,
      framework: framework.length ? framework : undefined,
      accountId: accountId || undefined,
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
          <Badge variant="outline" className="text-xxs-400">
            {row.original.framework}
            {row.original.framework_version && (
              <span className="ml-1 text-muted-foreground">
                {row.original.framework_version}
              </span>
            )}
          </Badge>
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
            <span className="font-mono text-s-400 text-muted-foreground">
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
        cell: ({ row }) => <PassRateCell run={row.original} />,
        enableSorting: false,
      },
      {
        id: 'total',
        accessorKey: 'total',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Cases" />,
        cell: ({ row }) => <span className="text-s-400">{row.original.total}</span>,
        enableSorting: false,
        meta: { label: 'Cases' },
      },
      {
        id: 'duration_ms',
        accessorKey: 'duration_ms',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Duration" />,
        cell: ({ row }) => (
          <span className="text-s-400">{formatDuration(row.original.duration_ms)}</span>
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
        meta: { label: 'Started' },
      },
      {
        id: 'commit',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Commit" />,
        cell: ({ row }) => (
          <span className="font-mono text-xs-400 text-muted-foreground">
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
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 mb-4 text-s-400 text-destructive">
          Failed to load eval runs: {error}
        </div>
      )}

      {loading && (
        <div className="mb-3 text-xs-400 text-muted-foreground">Loading…</div>
      )}

      <DataTable
        table={table}
        onRowClick={(row) => onRunClick?.(row.original.run_id)}
      >
        <DataTableToolbar table={table} />
      </DataTable>
    </div>
  )
}
