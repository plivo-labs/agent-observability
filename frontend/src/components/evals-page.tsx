import { useMemo } from 'react'
import { parseAsArrayOf, parseAsInteger, parseAsString, useQueryState } from 'nuqs'
import type { ColumnDef } from '@tanstack/react-table'
import { Bot, FlaskConical, type LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { ObsDataTable } from '@/components/data-table/obs-data-table'
import { useDataTable } from '@/hooks/use-data-table'
import { cn } from '@/lib/utils'
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useEvalRuns } from '@/lib/observability-hooks'
import type { EvalRunRow } from '@/lib/observability-types'

// Agent framework — what the agent under test is built with.
const FRAMEWORK_OPTIONS = [
  { label: 'LiveKit', value: 'livekit' },
  { label: 'Pipecat', value: 'pipecat' },
]

// Testing framework — what ran the eval suite.
const TESTING_FRAMEWORK_OPTIONS = [
  { label: 'pytest', value: 'pytest' },
  { label: 'Vitest', value: 'vitest' },
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

function FrameworkPill({
  name,
  version,
  icon: Icon,
}: {
  name: string | null
  version: string | null
  icon: LucideIcon
}) {
  if (!name) return <span className="text-muted-foreground">—</span>
  return (
    <span className={cn(
      'inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted border text-xs-500 whitespace-nowrap',
    )}>
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      {name}
      {version && <span className="text-muted-foreground font-mono text-[11px]">{version}</span>}
    </span>
  )
}

function FrameworkBadge({ name, version }: { name: string | null; version: string | null }) {
  return <FrameworkPill name={name} version={version} icon={Bot} />
}

function TestingFrameworkBadge({ name, version }: { name: string; version: string | null }) {
  return <FrameworkPill name={name} version={version} icon={FlaskConical} />
}

export const EvalsPage = ({ onRunClick }: { onRunClick?: (runId: string) => void }) => {
  // URL-synced filter state — written by the DataTable toolbar via `useDataTable`.
  // Column ids below (`agent_id`, `account_id`, `framework`, `started_at`) become the URL keys.
  const [page] = useQueryState('page', parseAsInteger.withDefault(1))
  const [perPage] = useQueryState('perPage', parseAsInteger.withDefault(10))
  const [agentId] = useQueryState('agent_id', parseAsString.withDefault(''))
  const [accountId] = useQueryState('account_id', parseAsString.withDefault(''))
  const [framework] = useQueryState(
    'framework',
    parseAsArrayOf(parseAsString, ',').withDefault([]),
  )
  const [testingFramework] = useQueryState(
    'testing_framework',
    parseAsArrayOf(parseAsString, ',').withDefault([]),
  )
  // Single-date filter emits the picked day's midnight (local) as an epoch-ms
  // string. Expanded server-side into a 00:00 → next-midnight window.
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
      testingFramework: testingFramework.length ? testingFramework : undefined,
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
        id: 'testing_framework',
        accessorKey: 'testing_framework',
        header: ({ column }) => (
          <DataTableColumnHeader column={column} label="Testing Framework" />
        ),
        cell: ({ row }) => (
          <TestingFrameworkBadge
            name={row.original.testing_framework}
            version={row.original.testing_framework_version}
          />
        ),
        enableSorting: false,
        enableColumnFilter: true,
        meta: {
          label: 'Testing Framework',
          variant: 'multiSelect',
          options: TESTING_FRAMEWORK_OPTIONS,
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
        enableColumnFilter: true,
        meta: { label: 'Started', variant: 'date' },
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
    <div className="w-full p-6 flex flex-col gap-4 min-w-0">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-h2-600 font-semibold m-0">Evals</h1>
          <div className="text-s-400 text-muted-foreground">Test runs across your agents.</div>
        </div>
        <div className="text-s-400 text-muted-foreground">
          <b className="text-foreground">{totalCount}</b> total
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="border border-border bg-muted text-foreground px-4 py-2.5 rounded-lg text-s-400"
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
