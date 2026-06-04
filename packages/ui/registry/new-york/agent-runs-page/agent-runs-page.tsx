import { useEffect, useMemo, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { GitBranch, Scale, Trash2 } from 'lucide-react'
import { Link } from 'react-router'
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
import { ObsDataTable } from '@/components/data-table/obs-data-table'
import { useDataTable } from '@/components/data-table/use-data-table'
import { useEvalRuns } from '@/lib/observability-hooks'
import { useObservabilityContext } from '@/lib/observability-provider'
import {
  formatCost,
  formatDate,
  formatDuration,
  formatMs,
  formatTokens,
} from '@/lib/observability-format'
import type { CiMetadata, EvalRunRow } from '@/lib/observability-types'
import { KpiTile } from '@/components/kpi'

function getCommitLink(ci: CiMetadata | null, sha: string | undefined): string | null {
  if (!ci || !sha) return null

  const explicit = typeof ci.git_commit_url === 'string' ? ci.git_commit_url : null
  if (explicit) return explicit

  const runUrl = typeof ci.run_url === 'string' ? ci.run_url : null
  if (!runUrl) return null

  const provider = typeof ci.provider === 'string' ? ci.provider.toLowerCase() : ''
  if (provider === 'github') {
    const marker = '/actions/runs/'
    const idx = runUrl.indexOf(marker)
    if (idx > 0) return `${runUrl.slice(0, idx)}/commit/${sha}`
  }
  if (provider === 'gitlab') {
    const marker = '/-/jobs/'
    const idx = runUrl.indexOf(marker)
    if (idx > 0) return `${runUrl.slice(0, idx)}/-/commit/${sha}`
  }
  return null
}

// Pass-rate cell — matches the canonical `PassRateBar` used on the
// cross-agent /evals page so the Simulation Evals tab reads identically.
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

function CommitCell({ ci, sha }: { ci: CiMetadata | null; sha: string | null }) {
  const commitUrl = getCommitLink(ci, sha ?? undefined)
  if (!sha && !ci?.git_branch) return <span className="text-muted-foreground">—</span>
  if (sha && commitUrl) {
    return (
      <a
        href={commitUrl}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="font-mono text-foreground no-underline hover:underline"
        title={ci?.git_branch ? `${sha}\nbranch: ${String(ci.git_branch)}` : sha}
      >
        {sha.slice(0, 7)}
      </a>
    )
  }
  if (sha && !commitUrl) {
    return (
      <span
        title={ci?.git_branch ? `${sha}\nbranch: ${String(ci.git_branch)}` : sha}
        className="font-mono text-muted-foreground inline-flex items-center gap-1.5"
      >
        {sha.slice(0, 7)}
        <span className="text-[10px] leading-none px-1.5 py-0.5 rounded-full border text-muted-foreground">
          local
        </span>
      </span>
    )
  }
  return (
    <span
      className="text-muted-foreground inline-flex items-center gap-1"
      title={`branch: ${String(ci?.git_branch)}`}
    >
      <GitBranch size={12} />
      <span className="font-mono text-[11px]">{String(ci?.git_branch)}</span>
    </span>
  )
}

export function AgentRunsPage({
  agentId,
  onRunClick,
  onCompare,
  embedded = false,
}: {
  agentId: string
  onRunClick?: (runId: string) => void
  onCompare?: (runIdA: string, runIdB: string) => void
  /** When true, hides the breadcrumb + agent-id title since the
   * containing dashboard already provides them (agent-detail-page).
   * Embedded is the only mount point in the current IA; the standalone
   * branch is retained for future re-use but isn't routed today. */
  embedded?: boolean
}) {
  const { runs, meta, loading, error, refetch } = useEvalRuns(50, 0, { agentId })
  const totalRunCount = meta.total_count
  const { api } = useObservabilityContext()

  const validRuns = useMemo(() => runs.filter(r => r.total > 0), [runs])
  const hasTtfb = useMemo(() => runs.some(r => r.ttfb_p95_ms != null), [runs])

  const stats = useMemo(() => {
    const avgPass = validRuns.length
      ? validRuns.reduce((s, r) => s + (r.total > 0 ? r.passed / r.total : 0), 0) / validRuns.length
      : 0
    const p95Values = validRuns.map(r => r.ttft_p95_ms).filter((v): v is number => v != null)
    const avgP95 = p95Values.length
      ? p95Values.reduce((s, v) => s + v, 0) / p95Values.length
      : null
    const totalCost = runs.reduce((s, r) => s + (r.estimated_cost_usd ?? 0), 0)
    const chrono = [...validRuns].sort(
      (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime()
    )
    const passSeries = chrono.map(r => (r.total > 0 ? (r.passed / r.total) * 100 : 0))
    const p95Series = chrono
      .map(r => r.ttft_p95_ms)
      .filter((v): v is number => v != null)
    const costSeries = [...runs]
      .sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime())
      .map(r => r.estimated_cost_usd ?? 0)
    return {
      avgPass, avgP95, totalCost,
      passSeries, p95Series, costSeries,
    }
  }, [runs, validRuns])

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
        id: 'name',
        accessorKey: 'name',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Name" />,
        cell: ({ row }) =>
          row.original.name ? (
            <span className="font-medium truncate inline-block max-w-[220px] align-middle" title={row.original.name}>
              {row.original.name}
            </span>
          ) : (
            <span className="font-mono text-muted-foreground" title={row.original.run_id}>
              {row.original.run_id.slice(0, 8)}
            </span>
          ),
        enableSorting: false,
        enableColumnFilter: true,
        meta: {
          label: 'Name',
          placeholder: 'Filter by name or id',
          variant: 'text',
        },
      },
      {
        id: 'started_at',
        accessorKey: 'started_at',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Started" />,
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-2 tnum" style={{ color: 'hsl(var(--secondary))' }}>
            {row.original.status === 'running' && (
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            )}
            {formatDate(row.original.started_at)}
          </span>
        ),
        enableSorting: false,
        enableColumnFilter: true,
        meta: { label: 'Started', variant: 'date' },
      },
      {
        id: 'pass_rate',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Pass rate" />,
        cell: ({ row }) => {
          const r = row.original
          if (r.total === 0) return <span className="font-mono text-muted-foreground">—</span>
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
        cell: ({ row }) => <span className="font-mono tnum">{row.original.total}</span>,
        enableSorting: false,
        meta: { label: 'Cases' },
      },
      {
        id: 'duration_ms',
        accessorKey: 'duration_ms',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Duration" />,
        cell: ({ row }) => (
          <span className="font-mono tnum text-muted-foreground">
            {formatDuration(row.original.duration_ms)}
          </span>
        ),
        enableSorting: false,
        meta: { label: 'Duration' },
      },
      {
        id: 'ttft_p95_ms',
        accessorKey: 'ttft_p95_ms',
        header: ({ column }) => <DataTableColumnHeader column={column} label="p95 TTFT" />,
        cell: ({ row }) => {
          const v = row.original.ttft_p95_ms
          if (v == null) return <span className="font-mono text-muted-foreground">—</span>
          const bad = v > 10000
          return (
            <span className={`font-mono tnum ${bad ? 'text-destructive' : ''}`}>
              {formatMs(v)}
            </span>
          )
        },
        enableSorting: false,
        meta: { label: 'p95 TTFT' },
      },
      ...(hasTtfb ? [{
        id: 'ttfb_p95_ms',
        accessorKey: 'ttfb_p95_ms',
        header: ({ column }: { column: any }) => <DataTableColumnHeader column={column} label="p95 TTFB" />,
        cell: ({ row }: { row: any }) => (
          <span className="font-mono tnum text-muted-foreground">
            {row.original.ttfb_p95_ms != null ? formatMs(row.original.ttfb_p95_ms) : '—'}
          </span>
        ),
        enableSorting: false,
        meta: { label: 'p95 TTFB' },
      } as ColumnDef<EvalRunRow>] : []),
      {
        id: 'total_tokens',
        accessorKey: 'total_tokens',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Tokens" />,
        cell: ({ row }) => (
          <span className="font-mono tnum text-muted-foreground">
            {formatTokens(row.original.total_tokens)}
          </span>
        ),
        enableSorting: false,
        meta: { label: 'Tokens' },
      },
      {
        id: 'cache',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Cache" />,
        cell: ({ row }) => {
          const r = row.original
          if (r.prompt_tokens <= 0)
            return <span className="font-mono tnum text-muted-foreground">—</span>
          return (
            <span className="font-mono tnum text-muted-foreground">
              {Math.round((r.cached_prompt_tokens / r.prompt_tokens) * 100)}%
            </span>
          )
        },
        enableSorting: false,
        meta: { label: 'Cache' },
      },
      {
        id: 'estimated_cost_usd',
        accessorKey: 'estimated_cost_usd',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Est. cost" />,
        cell: ({ row }) => (
          <span className="font-mono tnum text-muted-foreground">
            {formatCost(row.original.estimated_cost_usd)}
          </span>
        ),
        enableSorting: false,
        meta: { label: 'Est. cost' },
      },
      {
        id: 'commit',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Commit" />,
        cell: ({ row }) => {
          const sha = row.original.ci?.git_sha ? String(row.original.ci.git_sha) : null
          return <CommitCell ci={row.original.ci} sha={sha} />
        },
        enableSorting: false,
        meta: { label: 'Commit' },
      },
    ],
    [hasTtfb],
  )

  const { table } = useDataTable({
    data: runs,
    columns,
    pageCount: 1,
    initialState: { pagination: { pageIndex: 0, pageSize: 10 } },
    getRowId: (row) => row.run_id,
  })

  const selectedIds = Object.keys(table.getState().rowSelection)
  const selectedCount = selectedIds.length
  const canCompare = selectedCount === 2

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

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

  // Auto-refresh while a run is in flight so the table tail shows live
  // progress without the user hitting reload.
  const hasRunningRun = runs.some((run) => run.status === 'running')
  useEffect(() => {
    if (!hasRunningRun) return
    const id = window.setInterval(() => refetch(), 1500)
    return () => window.clearInterval(id)
  }, [hasRunningRun, refetch])

  return (
    <div className={embedded ? 'w-full flex flex-col gap-4 min-w-0' : 'w-full p-6 flex flex-col gap-4 min-w-0'}>
      {!embedded && (
        <div className="eval-breadcrumbs">
          <Link to="/">Agents</Link>
          <span className="eval-breadcrumbs__sep">/</span>
          <Link to={`/agents/${encodeURIComponent(agentId)}?tab=simulation-evals`} className="font-mono">{agentId}</Link>
          <span className="eval-breadcrumbs__sep">/</span>
          <span className="eval-breadcrumbs__current">Simulation Evals</span>
        </div>
      )}

      <div className="flex items-start justify-between">
        <div>
          {!embedded && (
            <h1 className="m-0 font-mono font-semibold text-[20px]">{agentId}</h1>
          )}
          <div className={`flex items-center gap-2.5 text-s-400 text-muted-foreground${embedded ? '' : ' mt-1'}`}>
            <span>{runs.length} runs</span>
          </div>
        </div>
        {validRuns.length >= 2 && selectedCount === 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onCompare?.(validRuns[1].run_id, validRuns[0].run_id)}
          >
            <Scale size={14} /> Compare last 2
          </Button>
        )}
      </div>

      <div className="eval-kpi-grid">
        <KpiTile
          label="Avg pass rate"
          value={`${(stats.avgPass * 100).toFixed(1)}`}
          unit="%"
          sub={`across ${validRuns.length} run${validRuns.length === 1 ? '' : 's'}`}
          sparkValues={stats.passSeries}
          sparkColor="hsl(142 70% 28%)"
        />
        <KpiTile
          label="Avg p95 TTFT"
          value={stats.avgP95 != null ? formatMs(stats.avgP95) : '—'}
          sub={`across ${stats.p95Series.length} run${stats.p95Series.length === 1 ? '' : 's'}`}
          sparkValues={stats.p95Series}
          sparkColor="hsl(210 90% 42%)"
        />
        <KpiTile
          label="Total LLM cost"
          value={formatCost(stats.totalCost)}
          sub={`across ${runs.length} run${runs.length === 1 ? '' : 's'}`}
          sparkValues={stats.costSeries}
          sparkColor="hsl(35 90% 45%)"
        />
        <KpiTile
          label="Total runs"
          value={totalRunCount.toLocaleString()}
          sub={totalRunCount > runs.length ? `showing latest ${runs.length}` : undefined}
        />
      </div>

      {error && (
        <div
          role="alert"
          className="border border-border bg-muted text-foreground px-4 py-2.5 rounded-lg text-s-400"
        >
          Failed to load runs: {error}
        </div>
      )}

      {selectedCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border bg-card">
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
            {canCompare && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onCompare?.(selectedIds[0], selectedIds[1])}
              >
                <Scale size={14} /> Compare 2 runs
              </Button>
            )}
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

      <ObsDataTable
        table={table}
        toolbar={<DataTableToolbar table={table} />}
        onRowClick={(row) => onRunClick?.(row.original.run_id)}
        totalRowCount={runs.length}
        loading={loading}
      />

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
