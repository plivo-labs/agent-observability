import { useMemo, useState } from 'react'
import type * as React from 'react'
import { parseAsArrayOf, parseAsInteger, parseAsString, useQueryState } from 'nuqs'
import type { ColumnDef } from '@tanstack/react-table'
import { CornerDownRight, Trash2 } from 'lucide-react'
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
import { formatCost, formatDate, formatDuration, formatMs } from '@/lib/observability-format'
import { useAgentStats, useSessions } from '@/lib/observability-hooks'
import { useObservabilityContext } from '@/lib/observability-provider'
import type { AgentSessionRow, AgentStatsRange } from '@/lib/observability-types'
import { DurationCell, TransportPill } from '@/components/obs-cells'
import { KpiTile } from '@/components/kpi'

/** Server-marked snippet → React nodes. /api/sessions wraps matched words
 * in \u0001/\u0002 control chars (TS_HEADLINE_OPTIONS in src/index.ts);
 * splitting on them here keeps everything plain text nodes — the snippet
 * is user speech and must never be parsed as HTML. */
const SNIPPET_MARK = /\u0001([\s\S]*?)\u0002/g

const snippetNodes = (snippet: string): React.ReactNode[] => {
  const nodes: React.ReactNode[] = []
  let last = 0
  for (const m of snippet.matchAll(SNIPPET_MARK)) {
    // RegExpMatchArray.index is optional in some TS lib versions; matchAll
    // always sets it, so default defensively rather than assert.
    const idx = m.index ?? 0
    if (idx > last) nodes.push(snippet.slice(last, idx))
    nodes.push(
      <mark
        key={idx}
        className="rounded-[2px] bg-warning-bg px-0.5 font-medium text-warning-fg"
      >
        {m[1]}
      </mark>,
    )
    last = idx + m[0].length
  }
  if (last < snippet.length) nodes.push(snippet.slice(last))
  return nodes
}

const TRANSPORT_OPTIONS = [
  { label: 'SIP', value: 'sip' },
  { label: 'Audio Stream', value: 'audio_stream' },
  { label: 'Text', value: 'text' },
  { label: 'Terminal', value: 'terminal_text' },
]

export const SessionsPage = ({
  onSessionClick,
  agentId,
  range = '7d',
}: {
  onSessionClick?: (sessionId: string) => void
  /** When set, locks the list to this agent — every fetch includes
   * `agent_id=<value>` so the page can be embedded inside the agent
   * detail dashboard without an extra filter UI. */
  agentId?: string
  /** Window for the KPI tile sparklines. The agent detail header's
   * range picker propagates here so the strip stays in sync with the
   * Overview tab. Standalone (cross-agent) callers can leave the
   * default 7d. */
  range?: AgentStatsRange
}) => {
  // URL-synced filter state — written by the DataTable toolbar via `useDataTable`.
  // Column ids below (`transport`, `started_at`) become the URL keys.
  const [page] = useQueryState('page', parseAsInteger.withDefault(1))
  const [perPage] = useQueryState('perPage', parseAsInteger.withDefault(10))
  const [transport] = useQueryState(
    'transport',
    parseAsArrayOf(parseAsString, ',').withDefault([]),
  )
  // Free-text transcript search — written by the toolbar's text filter
  // (virtual column id `q` below), debounced by useDataTable before it
  // lands in the URL. The server does the matching (websearch syntax).
  const [q] = useQueryState('q', parseAsString.withDefault(''))
  const searchActive = q.trim().length > 0
  // Single-date filter emits the picked day's midnight (local) as an epoch-ms
  // string. We expand it server-side into a 00:00 → next-midnight window so
  // the query returns every session that started during that calendar day.
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

  const { sessions, meta, loading, error, refetch } = useSessions(
    perPage,
    (page - 1) * perPage,
    {
      q: q.trim() || undefined,
      agentId,
      startedFrom: startedFromIso,
      startedTo: startedToIso,
      transport: transport.length ? transport : undefined,
    },
  )

  const columns = useMemo<ColumnDef<AgentSessionRow>[]>(
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
            aria-label={`Select session ${row.original.session_id}`}
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
        id: 'session_id',
        accessorKey: 'session_id',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Session ID" />,
        cell: ({ row }) => (
          <span className="font-mono">{row.original.session_id}</span>
        ),
        enableSorting: false,
        meta: { label: 'Session ID' },
      },
      {
        // Virtual column: exists only so the toolbar renders a transcript
        // search input and syncs it to ?q=. Hidden from the table body and
        // the view-options menu; the server does the actual filtering. The
        // dummy accessor is required — getCanFilter() is false for
        // accessor-less display columns, which suppresses the toolbar input.
        id: 'q',
        accessorFn: () => '',
        enableColumnFilter: true,
        enableSorting: false,
        enableHiding: false,
        meta: { label: 'Transcript', placeholder: 'Search transcripts', variant: 'text' },
      },
      {
        id: 'transport',
        accessorKey: 'transport',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Transport" />,
        cell: ({ row }) => <TransportPill value={row.original.transport} />,
        enableSorting: false,
        enableColumnFilter: true,
        meta: {
          label: 'Transport',
          variant: 'multiSelect',
          options: TRANSPORT_OPTIONS,
        },
      },
      {
        id: 'started_at',
        accessorKey: 'started_at',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Started" />,
        cell: ({ row }) => (
          <span className="tnum" style={{ color: 'var(--ink-2)' }}>
            {formatDate(row.original.started_at)}
          </span>
        ),
        enableSorting: false,
        enableColumnFilter: true,
        meta: { label: 'Started', variant: 'date' },
      },
      {
        id: 'ended_at',
        accessorKey: 'ended_at',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Ended" />,
        cell: ({ row }) => (
          <span className="tnum" style={{ color: 'var(--ink-2)' }}>
            {formatDate(row.original.ended_at)}
          </span>
        ),
        enableSorting: false,
        meta: { label: 'Ended' },
      },
      {
        id: 'duration_ms',
        accessorKey: 'duration_ms',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Duration" />,
        cell: ({ row }) => <DurationCell ms={row.original.duration_ms} />,
        enableSorting: false,
        meta: { label: 'Duration' },
      },
      {
        // The agent_transport_sessions.turn_count column counts message items
        // (user + assistant). The session-detail KPI tile shows
        // summary.total_turns (logical user→assistant pairs), which is the
        // canonical "turn count" elsewhere. Same column, two semantics —
        // surface this one as "Messages" so neither lies, and let the KPI
        // tile own the word "Turns".
        id: 'turn_count',
        accessorKey: 'turn_count',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Messages" />,
        cell: ({ row }) => <span className="tnum">{row.original.turn_count}</span>,
        enableSorting: false,
        meta: { label: 'Messages' },
      },
    ],
    [],
  )

  const totalCount = meta.total_count
  const pageCount = Math.max(1, Math.ceil(totalCount / perPage))

  // Real time-series KPIs come from /api/agents/:id/stats which
  // pre-aggregates session counts, latency, durations, and
  // interruptions into per-day buckets. We only fetch when embedded
  // (agentId provided) — the cross-agent /sessions list (gone in this
  // IA but harmless to defend) would otherwise hit a 404. 7d gives a
  // sparkline 7-points wide which is the visual sweet spot.
  const { stats: agentStats } = useAgentStats(agentId, range)
  const kpiSeries = useMemo(() => {
    const buckets = agentStats?.buckets ?? []
    return {
      sessions: buckets.map((b) => b.session_count),
      p95Latency: buckets.map((b) => b.p95_user_perceived_ms ?? 0),
      avgDuration: buckets.map((b) => b.avg_duration_ms ?? 0),
      cost: buckets.map((b) => b.estimated_cost_usd ?? 0),
    }
  }, [agentStats])

  const { table } = useDataTable({
    data: sessions,
    columns,
    pageCount,
    initialState: {
      pagination: { pageIndex: 0, pageSize: 10 },
      columnVisibility: { q: false },
    },
    getRowId: (row) => row.session_id,
  })

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
      await api.deleteSessions(selectedIds)
      table.resetRowSelection()
      refetch()
      setConfirmOpen(false)
    } catch (e) {
      setDeleteError((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  // When embedded inside the agent-detail dashboard, the parent already
  // renders the breadcrumb + agent header — re-rendering an "obs-head"
  // here adds a duplicate H1 ("Sessions") and a 30-day subtitle that
  // doesn't match the picked range. Mirror AgentRunsPage's embedded
  // behavior: drop the head block entirely and let the parent govern
  // the top region; the `<b>{totalCount}</b> total` still surfaces in
  // the table toolbar.
  const embedded = !!agentId

  return (
    <>
      {!embedded && (
        <div className="obs-head">
          <div>
            <h1>Sessions</h1>
            <div className="sub">All sessions captured for this agent.</div>
          </div>
          <div className="total"><b>{totalCount}</b> total</div>
        </div>
      )}

      <div className="eval-kpi-grid" style={{ marginBottom: 16 }}>
        <KpiTile
          label="Sessions"
          value={(agentStats?.total_sessions ?? 0).toLocaleString()}
          sub={`${range} window · ${totalCount.toLocaleString()} all-time`}
          sparkValues={kpiSeries.sessions}
          sparkColor="var(--accent-purple)"
        />
        <KpiTile
          label="p95 perceived latency"
          value={
            agentStats?.p95_user_perceived_ms != null
              ? formatMs(agentStats.p95_user_perceived_ms)
              : '—'
          }
          sub={`user perceived · ${range}`}
          sparkValues={kpiSeries.p95Latency}
          sparkColor="var(--info)"
        />
        <KpiTile
          label="Avg duration"
          value={
            kpiSeries.avgDuration.length
              ? formatDuration(
                  Math.round(
                    kpiSeries.avgDuration.reduce((s, v) => s + v, 0) /
                      kpiSeries.avgDuration.length,
                  ),
                )
              : '—'
          }
          sub={`per session · ${range}`}
          sparkValues={kpiSeries.avgDuration}
          sparkColor="var(--warning)"
        />
        <KpiTile
          label="Total LLM cost"
          value={formatCost(agentStats?.total_estimated_cost_usd ?? null)}
          sub={`priced on token usage · ${range}`}
          sparkValues={kpiSeries.cost}
          sparkColor="var(--destructive)"
        />
      </div>

      {error && (
        <div
          role="alert"
          style={{
            border: '1px solid var(--destructive-border)',
            background: 'var(--destructive-bg)',
            color: 'var(--destructive)',
            padding: '10px 14px',
            borderRadius: 8,
            marginBottom: 12,
            font: 'var(--text-s-400)',
          }}
        >
          Failed to load sessions: {error}
        </div>
      )}

      {selectedCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 rounded-md border bg-card">
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
              className="text-destructive [&_svg]:text-current hover:[&_svg]:text-current border-destructive-border hover:bg-destructive-bg"
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
        onRowClick={(row) => onSessionClick?.(row.original.session_id)}
        totalRowCount={totalCount}
        loading={loading}
        renderRowDetail={
          searchActive
            ? (row) =>
                row.original.match_snippet ? (
                  <div className="flex min-w-0 items-baseline gap-1.5 pl-8 text-xs text-muted-foreground">
                    <CornerDownRight size={12} className="shrink-0 translate-y-0.5" />
                    <span className="block min-w-0 truncate">
                      {snippetNodes(row.original.match_snippet)}
                    </span>
                  </div>
                ) : null
            : undefined
        }
      />

      <Dialog open={confirmOpen} onOpenChange={(open) => !deleting && setConfirmOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selectedCount} session{selectedCount === 1 ? '' : 's'}?</DialogTitle>
            <DialogDescription>
              This permanently removes the selected session{selectedCount === 1 ? '' : 's'} and any
              associated chat history, metrics, and recording references. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <div className="text-s-400 text-destructive">
              Failed to delete: {deleteError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="outline"
              className="text-destructive border-destructive-border hover:bg-destructive-bg"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : `Delete ${selectedCount}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
