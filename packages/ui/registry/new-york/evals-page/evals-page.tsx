import { useMemo } from 'react'
import { parseAsArrayOf, parseAsInteger, parseAsString, useQueryState } from 'nuqs'
import type { ColumnDef, Row } from '@tanstack/react-table'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  FlaskConical,
  Layers,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { DataTablePagination } from '@/components/data-table/data-table-pagination'
import { useDataTable } from '@/components/data-table/use-data-table'
import { useDayFilter } from '@/components/data-table/use-day-filter'
import { useBulkDelete } from '@/components/data-table/use-bulk-delete'
import {
  DeleteConfirmDialog,
  SelectionToolbar,
} from '@/components/data-table/delete-confirm-dialog'
import { cn } from '@/lib/utils'
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useEvalRuns } from '@/lib/observability-hooks'
import { useObservabilityContext } from '@/lib/observability-provider'
import type { EvalRunRow } from '@/lib/observability-types'
import { toneForRate, toneClass, toneColorVar } from '@/lib/tone'
import { SelectableCard } from '@/components/selectable-card'

// Agent framework — what the agent under test is built with.
const FRAMEWORK_OPTIONS = [
  { label: 'LiveKit', value: 'livekit' },
  { label: 'Pipecat', value: 'pipecat' },
]

// Testing framework — what ran the eval suite.
const TESTING_FRAMEWORK_OPTIONS = [
  { label: 'pytest', value: 'pytest' },
  { label: 'Vitest', value: 'vitest' },
  { label: 'Simulation', value: 'simulation' },
  { label: 'Live call', value: 'live-call' },
]

function PassRateBar({ passed, total }: { passed: number; total: number }) {
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0
  // Tone the fill by health so a sweep of the column reads at a glance.
  const tone = toneColorVar(toneForRate(pct))
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <span
        className="font-mono text-xs-600 tabular-nums w-10"
        style={{ color: total > 0 ? tone : undefined }}
      >
        {pct}%
      </span>
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden max-w-[90px]">
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${pct}%`, background: total > 0 ? tone : 'hsl(var(--muted-foreground))' }}
        />
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

// Derive a Truman-style verdict from the run's case tallies:
//   pass    — every case finished and passed (total > 0)
//   fail    — at least one case failed or errored
//   pending — nothing has finished yet (in-flight / queued)
function deriveVerdict(run: EvalRunRow): { label: string; tone: string } {
  const failed = run.failed + run.errored
  if (failed > 0) {
    return {
      label: 'fail',
      tone:
        'text-[hsl(var(--destructive))] border-[hsl(var(--destructive-border))] bg-[hsl(var(--destructive-bg))]',
    }
  }
  // A run is complete once every case is accounted for (passed/failed/errored/
  // skipped). Skipped cases don't block a pass — keying off `passed >= total`
  // alone left a finished run with skipped cases stuck on "pending" forever.
  const accounted = run.passed + run.failed + run.errored + run.skipped
  if (run.total > 0 && accounted >= run.total) {
    return {
      label: 'pass',
      tone: 'text-[hsl(var(--success))] border-[hsl(var(--success)/0.4)] bg-[hsl(var(--success)/0.1)]',
    }
  }
  return {
    label: 'pending',
    tone: 'text-[hsl(var(--warning))] border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.1)]',
  }
}

// One eval run rendered as a Truman "Recent runs" card: sharp-radius panel,
// title + mono meta line + verdict pill, a pass summary body, and a
// localized timestamp footer. Clickable → run detail (via onOpen).
function RunCard({
  row,
  onOpen,
}: {
  row: Row<EvalRunRow>
  onOpen: (runId: string) => void
}) {
  const run = row.original
  const verdict = deriveVerdict(run)
  const title = run.agent_id || `Run ${run.run_id.slice(0, 8)}`
  const failed = run.failed + run.errored
  const summary =
    run.total > 0
      ? `${run.passed}/${run.total} cases passed${failed > 0 ? ` · ${failed} failed` : ''}`
      : 'No cases recorded yet.'

  return (
    <SelectableCard
      selected={row.getIsSelected()}
      onToggle={(value) => row.toggleSelected(value)}
      onOpen={() => onOpen(run.run_id)}
      selectAriaLabel={`Select run ${run.run_id}`}
      title={title}
      meta={
        <>
          {run.account_id && (
            <>
              <span className="truncate">{run.account_id}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <span>run {run.run_id.slice(0, 8)}</span>
          <span aria-hidden>·</span>
          <span>{formatDuration(run.duration_ms)}</span>
          {run.testing_framework && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{run.testing_framework}</span>
            </>
          )}
        </>
      }
      pill={
        <span
          className={cn(
            'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
            verdict.tone,
          )}
        >
          {verdict.label}
        </span>
      }
      footer={formatDate(run.started_at)}
    >
      <div className="mt-3 line-clamp-2 text-sm text-muted-foreground">
        <span className="text-foreground">{summary}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <PassRateBar passed={run.passed} total={run.total} />
        <FrameworkBadge name={run.framework} version={run.framework_version} />
        <TestingFrameworkBadge
          name={run.testing_framework}
          version={run.testing_framework_version}
        />
      </div>
    </SelectableCard>
  )
}

export const EvalsPage =({ onRunClick }: { onRunClick?: (runId: string) => void }) => {
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
  // string. `useDayFilter` expands it into a 00:00 → next-midnight window.
  const [startedAt] = useQueryState(
    'started_at',
    parseAsArrayOf(parseAsString, ',').withDefault([]),
  )
  const { fromIso: startedFromIso, toIso: startedToIso } = useDayFilter(startedAt)

  const { runs, meta, loading, error, refetch } = useEvalRuns(
    perPage,
    (page - 1) * perPage,
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
        id: 'select',
        header: ({ table }) => (
          <Checkbox
            aria-label="Select all rows on this page"
            checked={
              table.getIsAllPageRowsSelected()
                ? true
                : table.getIsSomePageRowsSelected()
                  ? 'indeterminate'
                  : false
            }
            onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
            onClick={(e) => e.stopPropagation()}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            aria-label={`Select run ${row.original.run_id}`}
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            onClick={(e) => e.stopPropagation()}
          />
        ),
        enableSorting: false,
        enableHiding: false,
        size: 32,
      },
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
    ],
    [],
  )

  const totalCount = meta.total_count
  const pageCount = Math.max(1, Math.ceil(totalCount / perPage))

  // Page-scoped aggregates for the KPI rail — derived purely from the runs
  // already in hand (the current page), no extra fetch. Reads as "this view".
  const stats = useMemo(() => {
    let cases = 0
    let passed = 0
    let failed = 0
    for (const r of runs) {
      cases += r.total
      passed += r.passed
      failed += r.failed + r.errored
    }
    const passRate = cases > 0 ? Math.round((passed / cases) * 100) : 0
    return { cases, passed, failed, passRate }
  }, [runs])
  const passRateTone = stats.cases === 0 ? '' : toneClass(stats.passRate)

  const { table } = useDataTable({
    data: runs,
    columns,
    pageCount,
    initialState: { pagination: { pageIndex: 0, pageSize: 10 } },
    getRowId: (row) => row.run_id,
  })

  const rows = table.getRowModel().rows

  const { api } = useObservabilityContext()
  const {
    confirmOpen,
    setConfirmOpen,
    deleting,
    deleteError,
    selectedCount,
    handleDelete,
    cancelSelection,
  } = useBulkDelete({
    table,
    deleteFn: (ids) => api.deleteEvalRuns(ids),
    refetch,
  })

  return (
    <div className="w-full p-6 flex flex-col gap-5 min-w-0">
      <header className="ao-hero ao-reveal">
        <div>
          <div className="ao-hero-eyebrow">
            <FlaskConical /> Evals
          </div>
          <h1 className="ao-hero-title">Eval runs</h1>
          <p className="ao-hero-sub">
            Every test run across your agents — by framework, testing harness, and pass rate.
          </p>
        </div>
        <div className="ao-hero-actions">
          <span className="ao-badge is-neutral ao-badge--dot">
            {totalCount} {totalCount === 1 ? 'run' : 'runs'}
          </span>
        </div>
      </header>

      <div className="ao-stat-row ao-stagger ao-reveal ao-reveal-2">
        <div className="ao-stat ao-stat--feature is-accent">
          <div className="ao-stat-label">
            <Layers /> Runs
          </div>
          <div className="ao-stat-value">{totalCount}</div>
          <div className="ao-stat-meta">
            {runs.length} on this page
          </div>
        </div>
        <div className={cn('ao-stat', passRateTone)}>
          <div className="ao-stat-label">Pass rate</div>
          <div className="ao-stat-value">
            {stats.passRate}
            <span className="unit">%</span>
          </div>
          <div className="ao-stat-meta">across {stats.cases} cases</div>
        </div>
        <div className="ao-stat is-good">
          <div className="ao-stat-label">
            <CheckCircle2 /> Passed
          </div>
          <div className="ao-stat-value">{stats.passed}</div>
          <div className="ao-stat-meta">cases on this page</div>
        </div>
        <div className={cn('ao-stat', stats.failed > 0 && 'is-bad')}>
          <div className="ao-stat-label">
            <XCircle /> Failed
          </div>
          <div className="ao-stat-value">{stats.failed}</div>
          <div className="ao-stat-meta">incl. errored</div>
        </div>
      </div>

      {error && (
        <div role="alert" className="ao-alert is-danger">
          <AlertTriangle />
          <span>Failed to load eval runs: {error}</span>
        </div>
      )}

      <SelectionToolbar
        count={selectedCount}
        onCancel={cancelSelection}
        onDelete={() => setConfirmOpen(true)}
      />

      <div className="ao-reveal ao-reveal-3 flex flex-col gap-2.5">
        <DataTableToolbar table={table} />
        {loading && rows.length === 0 ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <SelectableCard key={`sk-${i}`} loading />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div
            className="flex h-24 items-center justify-center border bg-card text-muted-foreground shadow-sm"
            style={{ borderRadius: 'var(--radius)' }}
          >
            No results.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {rows.map((row) => (
              <RunCard
                key={row.id}
                row={row}
                onOpen={(runId) => onRunClick?.(runId)}
              />
            ))}
          </div>
        )}
        <DataTablePagination table={table} totalRowCount={totalCount} />
      </div>

      <DeleteConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${selectedCount} eval run${selectedCount === 1 ? '' : 's'}?`}
        description={`This permanently removes the selected run${selectedCount === 1 ? '' : 's'} and every case, event, and judgment captured under ${selectedCount === 1 ? 'it' : 'them'}. This cannot be undone.`}
        deleting={deleting}
        deleteError={deleteError}
        confirmLabel={`Delete ${selectedCount}`}
        onConfirm={handleDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  )
}
