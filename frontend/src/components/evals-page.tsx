import { useMemo } from 'react'
import { parseAsArrayOf, parseAsInteger, parseAsString, useQueryState } from 'nuqs'
import type { ColumnDef } from '@tanstack/react-table'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { ObsDataTable } from '@/components/data-table/obs-data-table'
import { useDataTable } from '@/hooks/use-data-table'
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useEvalRuns } from '@/lib/observability-hooks'
import type { EvalRunRow } from '@/lib/observability-types'
import { FrameworkPill, PassRate } from '@/components/obs-cells'

const FRAMEWORK_OPTIONS = [
  { label: 'pytest', value: 'pytest' },
  { label: 'vitest', value: 'vitest' },
]

export const EvalsPage = ({ onRunClick }: { onRunClick?: (runId: string) => void }) => {
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
        cell: ({ row }) => <span className="mono">{row.original.run_id.slice(0, 8)}</span>,
        enableSorting: false,
        meta: { label: 'Run' },
      },
      {
        id: 'agent_id',
        accessorKey: 'agent_id',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Agent" />,
        cell: ({ row }) =>
          row.original.agent_id ? (
            <span style={{ font: 'var(--text-p-500)' }}>{row.original.agent_id}</span>
          ) : (
            <span className="muted">—</span>
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
          <FrameworkPill
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
            <span className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
              {row.original.account_id}
            </span>
          ) : (
            <span className="muted">—</span>
          ),
        enableSorting: false,
        enableColumnFilter: true,
        meta: { label: 'Account', placeholder: 'Filter by account', variant: 'text' },
      },
      {
        id: 'pass_rate',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Pass rate" />,
        cell: ({ row }) => (
          <PassRate
            passed={row.original.passed}
            total={row.original.total}
            failed={row.original.failed + row.original.errored}
          />
        ),
        enableSorting: false,
      },
      {
        id: 'total',
        accessorKey: 'total',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Cases" />,
        cell: ({ row }) => <span className="tnum">{row.original.total}</span>,
        enableSorting: false,
        meta: { label: 'Cases' },
      },
      {
        id: 'duration_ms',
        accessorKey: 'duration_ms',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Duration" />,
        cell: ({ row }) => (
          <span className="mono tnum">{formatDuration(row.original.duration_ms)}</span>
        ),
        enableSorting: false,
        meta: { label: 'Duration' },
      },
      {
        id: 'started_at',
        accessorKey: 'started_at',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Started" />,
        cell: ({ row }) => (
          <span className="tnum" style={{ color: 'hsl(var(--secondary))' }}>
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
          <span className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
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
    <>
      <div className="obs-head">
        <div>
          <h1>Evals</h1>
          <div className="sub">Test runs across your agents.</div>
        </div>
        <div className="total"><b>{totalCount}</b> total</div>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            border: '1px solid #FECACA',
            background: '#FEF2F2',
            color: 'hsl(var(--destructive))',
            padding: '10px 14px',
            borderRadius: 8,
            marginBottom: 12,
            font: 'var(--text-s-400)',
          }}
        >
          Failed to load eval runs: {error}
        </div>
      )}

      {loading && (
        <div style={{ marginBottom: 10, font: 'var(--text-xs-400)', color: 'hsl(var(--tertiary))' }}>
          Loading…
        </div>
      )}

      <ObsDataTable
        table={table}
        toolbar={<DataTableToolbar table={table} />}
        onRowClick={(row) => onRunClick?.(row.original.run_id)}
      />
    </>
  )
}
