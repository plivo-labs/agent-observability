import { useMemo, useState } from 'react'
import { parseAsArrayOf, parseAsInteger, parseAsString, useQueryState } from 'nuqs'
import type { ColumnDef, Row, Table } from '@tanstack/react-table'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  FlaskConical,
  Layers,
  Trash2,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { DataTablePagination } from '@/components/data-table/data-table-pagination'
import { useDataTable } from '@/components/data-table/use-data-table'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useEvalRuns } from '@/lib/observability-hooks'
import { useObservabilityContext } from '@/lib/observability-provider'
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
  { label: 'Simulation', value: 'simulation' },
  { label: 'Live call', value: 'live-call' },
]

function PassRateBar({ passed, total }: { passed: number; total: number }) {
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0
  // Tone the fill by health so a sweep of the column reads at a glance.
  const tone =
    pct >= 90
      ? 'hsl(var(--success))'
      : pct >= 60
        ? 'hsl(var(--warning))'
        : 'hsl(var(--destructive))'
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
  compact,
}: {
  name: string | null
  version: string | null
  icon: LucideIcon
  compact?: boolean
}) {
  if (!name) return <span className="text-muted-foreground">—</span>
  return (
    <span className={cn(
      'inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-muted whitespace-nowrap',
      compact ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs-500',
    )}>
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      {name}
      {version && <span className="text-muted-foreground font-mono text-[11px]">{version}</span>}
    </span>
  )
}

function FrameworkBadge({ name, version, compact }: { name: string | null; version: string | null; compact?: boolean }) {
  return <FrameworkPill name={name} version={version} icon={Bot} compact={compact} />
}

function TestingFrameworkBadge({ name, version, compact }: { name: string; version: string | null; compact?: boolean }) {
  return <FrameworkPill name={name} version={version} icon={FlaskConical} compact={compact} />
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
  if (run.total > 0 && run.passed >= run.total) {
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

// One eval run as a dense single-line row (matches the compacted Sessions
// list): checkbox · agent/title + mono run-id · framework badges · verdict
// pill · pass-rate · cases · duration · timestamp. Clickable → run detail.
// Shared per-column width/flex classes so the header row and the data rows
// (+ skeleton) physically can't drift. Mirrors the Sessions list `COL`.
const COL = {
  select: 'flex w-4 shrink-0 items-center',
  run: 'min-w-0 flex-1',
  framework: 'hidden w-[176px] shrink-0 xl:block',
  verdict: 'w-[72px] shrink-0',
  passRate: 'hidden w-[120px] shrink-0 md:block',
  cases: 'hidden w-[64px] shrink-0 whitespace-nowrap text-right sm:block',
  duration: 'w-[64px] shrink-0 whitespace-nowrap text-right',
  started: 'hidden w-[168px] shrink-0 truncate whitespace-nowrap lg:block',
} as const

// Subtle, on-theme column header — small uppercase mono labels with a bottom
// border. Carries the select-all checkbox in the first slot. Matches the
// Monitor → Sessions list header so both tables read identically.
function EvalListHeader({ table }: { table: Table<EvalRunRow> }) {
  const labelCls = 'text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80'
  // Gate header labels on the same column visibility the rows use, so toggling a
  // column in the View menu hides the label AND the cell, keeping them aligned.
  const visible = new Set(table.getVisibleLeafColumns().map((c) => c.id))
  const showFramework = visible.has('framework') || visible.has('testing_framework')
  return (
    <div className="flex items-center gap-3 border-b border-border px-3 pb-1.5" style={{ fontFamily: 'var(--mono)' }}>
      <div className={COL.select}>
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
      </div>
      <span className={cn(COL.run, labelCls)}>Run</span>
      {showFramework && <span className={cn(COL.framework, labelCls)}>Framework</span>}
      <span className={cn(COL.verdict, labelCls)}>Verdict</span>
      {visible.has('pass_rate') && <span className={cn(COL.passRate, labelCls)}>Pass rate</span>}
      {visible.has('total') && <span className={cn(COL.cases, labelCls)}>Cases</span>}
      {visible.has('duration_ms') && <span className={cn(COL.duration, labelCls)}>Duration</span>}
      {visible.has('started_at') && <span className={cn(COL.started, labelCls)}>Started</span>}
    </div>
  )
}

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
  // Reflect the View menu (column-visibility) state: getVisibleCells() drops
  // hidden columns, so gating each card field on its column id makes the
  // toggles actually hide/show. Column ids come from the `columns` useMemo.
  const visible = new Set(row.getVisibleCells().map((cell) => cell.column.id))
  // Render the framework slot only when at least one of its two badges is on,
  // so the xl: column doesn't reserve empty width when both are hidden.
  const showFramework = visible.has('framework') || visible.has('testing_framework')

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        const t = e.target as HTMLElement
        if (t.closest('button, a, input, select, [role="menuitem"]')) return
        onOpen(run.run_id)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(run.run_id)
        }
      }}
      data-state={row.getIsSelected() ? 'selected' : undefined}
      className={cn(
        'group flex cursor-pointer items-center gap-3 border bg-card px-3 py-2 transition-colors',
        'rounded-[var(--radius)] hover:border-[hsl(var(--muted-foreground)/0.4)] hover:bg-muted/30',
        row.getIsSelected() && 'border-[hsl(var(--primary))] bg-muted/30',
      )}
      style={{ borderRadius: 'var(--radius)' }}
    >
      <div className={COL.select}>
        <Checkbox
          aria-label={`Select run ${run.run_id}`}
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
      <div className={cn(COL.run, 'flex items-center gap-2')}>
        <span className="truncate text-sm text-foreground" style={{ fontFamily: 'var(--font-display)' }}>
          {title}
        </span>
        {visible.has('run_id') && (
          <span className="shrink-0 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70" style={{ fontFamily: 'var(--mono)' }}>
            {run.run_id.slice(0, 8)}
          </span>
        )}
      </div>
      {showFramework && (
        <div className={COL.framework}>
          <div className="flex items-center gap-1.5 overflow-hidden">
            {visible.has('framework') && (
              <FrameworkBadge name={run.framework} version={run.framework_version} compact />
            )}
            {visible.has('testing_framework') && (
              <TestingFrameworkBadge name={run.testing_framework} version={run.testing_framework_version} compact />
            )}
          </div>
        </div>
      )}
      <span className={cn(COL.verdict, 'truncate rounded-full border px-2 py-0.5 text-center text-[10px] font-medium uppercase tracking-wide', verdict.tone)}>
        {verdict.label}
      </span>
      {visible.has('pass_rate') && (
        <div className={COL.passRate}>
          <PassRateBar passed={run.passed} total={run.total} />
        </div>
      )}
      {visible.has('total') && (
        <span className={cn(COL.cases, 'text-[10px] uppercase tracking-[0.16em] text-muted-foreground')} style={{ fontFamily: 'var(--mono)' }}>
          {run.total} {run.total === 1 ? 'case' : 'cases'}
        </span>
      )}
      {visible.has('duration_ms') && (
        <span className={cn(COL.duration, 'text-[10px] tabular-nums text-muted-foreground')} style={{ fontFamily: 'var(--mono)' }}>
          {formatDuration(run.duration_ms)}
        </span>
      )}
      {visible.has('started_at') && (
        <span className={cn(COL.started, 'truncate text-[10px] uppercase tracking-[0.12em] text-muted-foreground')} style={{ fontFamily: 'var(--mono)' }} title={formatDate(run.started_at)}>
          {formatDate(run.started_at)}
        </span>
      )}
    </div>
  )
}

function RunCardSkeleton() {
  return (
    <div
      className="flex items-center gap-3 border bg-card px-3 py-2"
      style={{ borderRadius: 'var(--radius)' }}
    >
      <div className={COL.select}><Skeleton className="h-4 w-4" /></div>
      <Skeleton className={cn(COL.run, 'h-4')} />
      <div className={COL.framework}><Skeleton className="h-5 w-full rounded-full" /></div>
      <Skeleton className={cn(COL.verdict, 'h-5 rounded-full')} />
      <div className={COL.passRate}><Skeleton className="h-3 w-full" /></div>
      <Skeleton className={cn(COL.cases, 'h-3')} />
      <Skeleton className={cn(COL.duration, 'h-3')} />
      <div className={COL.started}><Skeleton className="h-3 w-full" /></div>
    </div>
  )
}

export const EvalsPage = ({ onRunClick }: { onRunClick?: (runId: string) => void }) => {
  // URL-synced filter state — written by the DataTable toolbar via `useDataTable`.
  // Column ids below (`agent_id`, `framework`, `started_at`) become the URL keys.
  const [page] = useQueryState('page', parseAsInteger.withDefault(1))
  const [perPage] = useQueryState('perPage', parseAsInteger.withDefault(10))
  const [agentId] = useQueryState('agent_id', parseAsString.withDefault(''))
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
  //
  // The `started_at` URL key is owned by `useDataTable` (the toolbar's date
  // picker writes it). That column has no `meta.options`, so `useDataTable`
  // registers it with a *single-string* parser and serializes the picked epoch
  // ms as a plain string. Read it back with the SAME `parseAsString` shape —
  // a second hook with a different parser (e.g. `parseAsArrayOf`) makes the two
  // nuqs hooks disagree on the key's serialization and the picked value never
  // lands in the URL.
  const [startedAt] = useQueryState(
    'started_at',
    parseAsString.withDefault(''),
  )
  const startedDay = useMemo(() => {
    if (!startedAt) return undefined
    const d = new Date(Number(startedAt))
    return Number.isNaN(d.getTime()) ? undefined : d
  }, [startedAt])
  const startedFromIso = useMemo(() => startedDay?.toISOString(), [startedDay])
  const startedToIso = useMemo(() => {
    if (!startedDay) return undefined
    const end = new Date(startedDay)
    end.setHours(23, 59, 59, 999)
    return end.toISOString()
  }, [startedDay])

  const { runs, meta, loading, error, refetch } = useEvalRuns(
    perPage,
    (page - 1) * perPage,
    {
      agentId: agentId || undefined,
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
  const passRateTone =
    stats.cases === 0 ? '' : stats.passRate >= 90 ? 'is-good' : stats.passRate >= 60 ? 'is-warn' : 'is-bad'

  const { table } = useDataTable({
    data: runs,
    columns,
    pageCount,
    initialState: { pagination: { pageIndex: 0, pageSize: 10 } },
    getRowId: (row) => row.run_id,
  })

  const rows = table.getRowModel().rows

  const { api } = useObservabilityContext()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const selectedIds = Object.keys(table.getState().rowSelection)
  const selectedCount = selectedIds.length

  const handleDelete = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await api.deleteEvalRuns(selectedIds)
      table.resetRowSelection()
      refetch()
      setConfirmOpen(false)
    } catch (e) {
      setDeleteError((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

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

      {selectedCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border bg-card shadow-sm">
          <span className="text-s-500">
            <b>{selectedCount}</b> selected
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.resetRowSelection()}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-[hsl(var(--destructive))] [&_svg]:text-current hover:[&_svg]:text-current border-[hsl(var(--destructive-border))] hover:bg-[hsl(var(--destructive-bg))]"
              onClick={() => setConfirmOpen(true)}
            >
              <Trash2 /> Delete
            </Button>
          </div>
        </div>
      )}

      <div className="ao-reveal ao-reveal-3 flex flex-col gap-2.5">
        <DataTableToolbar table={table} />
        {loading && rows.length === 0 ? (
          <div className="flex flex-col gap-1.5">
            <EvalListHeader table={table} />
            {Array.from({ length: 5 }).map((_, i) => (
              <RunCardSkeleton key={`sk-${i}`} />
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
          <div className="flex flex-col gap-1.5">
            <EvalListHeader table={table} />
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

      <Dialog open={confirmOpen} onOpenChange={(open) => !deleting && setConfirmOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selectedCount} eval run{selectedCount === 1 ? '' : 's'}?</DialogTitle>
            <DialogDescription>
              This permanently removes the selected run{selectedCount === 1 ? '' : 's'} and every
              case, event, and judgment captured under {selectedCount === 1 ? 'it' : 'them'}. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <div className="text-s-400 text-[hsl(var(--destructive))]">
              Failed to delete: {deleteError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="outline"
              className="text-[hsl(var(--destructive))] border-[hsl(var(--destructive-border))] hover:bg-[hsl(var(--destructive-bg))]"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : `Delete ${selectedCount}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
