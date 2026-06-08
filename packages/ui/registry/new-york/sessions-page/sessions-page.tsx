import { useMemo } from 'react'
import { parseAsArrayOf, parseAsInteger, parseAsString, useQueryState } from 'nuqs'
import type { ColumnDef, Row } from '@tanstack/react-table'
import {
  Activity,
  AlertTriangle,
  AudioLines,
  Clock,
  Database,
  Layers,
  Phone,
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { SelectableCard } from '@/components/selectable-card'
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
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useSessions } from '@/lib/observability-hooks'
import { useObservabilityContext } from '@/lib/observability-provider'
import type { AgentSessionRow } from '@/lib/observability-types'
import { CapsChips, DurationCell, TransportPill } from '@/components/obs-cells'

const TRANSPORT_OPTIONS = [
  { label: 'SIP', value: 'sip' },
  { label: 'Audio Stream', value: 'audio_stream' },
]

// Human label for the neutral status pill. Transport when present, else state.
const TRANSPORT_LABELS: Record<string, string> = {
  sip: 'SIP',
  audio_stream: 'Audio Stream',
  text: 'Text',
  terminal_text: 'Terminal Text',
  phone: 'Phone',
}

// One agent session rendered as a Truman "Recent runs" card: sharp-radius panel,
// title + mono meta line + neutral status pill, a pipeline/turns body, and a
// localized timestamp footer. Sessions have no pass/fail — the pill stays
// neutral (muted tokens), never green/red. Clickable → session detail (onOpen).
function SessionCard({
  row,
  onOpen,
}: {
  row: Row<AgentSessionRow>
  onOpen: (sessionId: string) => void
}) {
  const session = row.original
  const idShort = session.session_id.slice(0, 8)
  const title = session.account_id || `Session ${idShort}`
  // The meta line below already prints the transport, so the pill shows the
  // session STATE (otherwise transport rendered twice and state never showed).
  const pill = session.state
  const textOnly = session.transport === 'text' || session.transport === 'terminal_text'

  return (
    <SelectableCard
      selected={row.getIsSelected()}
      onToggle={(value) => row.toggleSelected(value)}
      onOpen={() => onOpen(session.session_id)}
      selectAriaLabel={`Select session ${session.session_id}`}
      title={title}
      meta={
        <>
          {session.transport && (
            <>
              <span className="truncate">{TRANSPORT_LABELS[session.transport] ?? session.transport}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <span>{idShort}</span>
          <span aria-hidden>·</span>
          <span>{session.turn_count} turns</span>
          <span aria-hidden>·</span>
          <span>{formatDuration(session.duration_ms)}</span>
        </>
      }
      pill={
        pill && (
          <span className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-muted text-muted-foreground border-border">
            {pill}
          </span>
        )
      }
      footer={formatDate(session.started_at)}
    >
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <CapsChips
          stt={!textOnly && session.has_stt}
          llm={session.has_llm}
          tts={!textOnly && session.has_tts}
        />
        <span className="text-xs uppercase tracking-wide text-muted-foreground" style={{ fontFamily: 'var(--mono)' }}>
          {session.turn_count} {session.turn_count === 1 ? 'turn' : 'turns'}
        </span>
      </div>
    </SelectableCard>
  )
}

export const SessionsPage =({ onSessionClick }: { onSessionClick?: (sessionId: string) => void }) => {
  // URL-synced filter state — written by the DataTable toolbar via `useDataTable`.
  // Column ids below (`account_id`, `transport`, `started_at`) become the URL keys.
  const [page] = useQueryState('page', parseAsInteger.withDefault(1))
  const [perPage] = useQueryState('perPage', parseAsInteger.withDefault(10))
  const [accountId] = useQueryState('account_id', parseAsString.withDefault(''))
  const [transport] = useQueryState(
    'transport',
    parseAsArrayOf(parseAsString, ',').withDefault([]),
  )
  // Single-date filter emits the picked day's midnight (local) as an epoch-ms
  // string. `useDayFilter` expands it into a 00:00 → next-midnight window so
  // the query returns every session that started during that calendar day.
  const [startedAt] = useQueryState(
    'started_at',
    parseAsArrayOf(parseAsString, ',').withDefault([]),
  )
  const { fromIso: startedFromIso, toIso: startedToIso } = useDayFilter(startedAt)

  const { sessions, meta, loading, error, refetch } = useSessions(
    perPage,
    (page - 1) * perPage,
    {
      accountId: accountId || undefined,
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
          <span className="ao-mono" style={{ color: 'hsl(var(--foreground))' }}>
            {row.original.session_id}
          </span>
        ),
        enableSorting: false,
        meta: { label: 'Session ID' },
      },
      {
        id: 'account_id',
        accessorKey: 'account_id',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Account" />,
        cell: ({ row }) =>
          row.original.account_id ? (
            <span className="ao-mono">{row.original.account_id}</span>
          ) : (
            <span className="ao-mono muted">—</span>
          ),
        enableSorting: false,
        enableColumnFilter: true,
        meta: { label: 'Account', placeholder: 'Filter by account', variant: 'text' },
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
          <span className="ao-mono tnum">{formatDate(row.original.started_at)}</span>
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
          <span className="ao-mono tnum">{formatDate(row.original.ended_at)}</span>
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
        id: 'turn_count',
        accessorKey: 'turn_count',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Turns" />,
        cell: ({ row }) => <span className="ao-mono tnum">{row.original.turn_count}</span>,
        enableSorting: false,
        meta: { label: 'Turns' },
      },
      {
        id: 'capabilities',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Capabilities" />,
        cell: ({ row }) => {
          const textOnly = row.original.transport === 'text' || row.original.transport === 'terminal_text'
          return (
            <CapsChips
              stt={!textOnly && row.original.has_stt}
              llm={row.original.has_llm}
              tts={!textOnly && row.original.has_tts}
            />
          )
        },
      },
    ],
    [],
  )

  const totalCount = meta.total_count
  const pageCount = Math.max(1, Math.ceil(totalCount / perPage))

  // Derived, page-local KPI stats. Purely presentational — computed from the
  // already-fetched page of sessions + the total-count meta (no extra fetch).
  const stats = useMemo(() => {
    const onPage = sessions.length
    const voiceOnPage = sessions.filter(
      (s) => s.transport === 'sip' || s.transport === 'audio_stream',
    ).length
    const turnsOnPage = sessions.reduce((acc, s) => acc + (Number(s.turn_count) || 0), 0)
    // Coerce to Number — some API paths return duration_ms as a string, which
    // would otherwise make the `+` below concatenate instead of sum.
    const durations = sessions
      .map((s) => Number(s.duration_ms))
      .filter((d) => Number.isFinite(d) && d >= 0)
    const avgDurationMs = durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null
    return { onPage, voiceOnPage, turnsOnPage, avgDurationMs }
  }, [sessions])

  const avgDurationLabel = useMemo(() => {
    if (stats.avgDurationMs == null) return '—'
    const totalSeconds = Math.round(stats.avgDurationMs / 1000)
    const m = Math.floor(totalSeconds / 60)
    const s = totalSeconds % 60
    return m > 0 ? `${m}m ${s}s` : `${s}s`
  }, [stats.avgDurationMs])

  const { table } = useDataTable({
    data: sessions,
    columns,
    pageCount,
    initialState: { pagination: { pageIndex: 0, pageSize: 10 } },
    getRowId: (row) => row.session_id,
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
    deleteFn: (ids) => api.deleteSessions(ids),
    refetch,
  })

  return (
    <div className="flex flex-col gap-6">
      <header className="ao-hero ao-reveal">
        <div>
          <div className="ao-hero-eyebrow">
            <Activity /> Observability · Monitor
          </div>
          <h1 className="ao-hero-title">Sessions</h1>
          <p className="ao-hero-sub">
            Every agent session captured in the last 30 days — transports, turns,
            duration, and pipeline capabilities at a glance.
          </p>
        </div>
        <div className="ao-hero-actions">
          <span className="ao-badge is-neutral ao-badge--dot">
            <Database size={12} /> {totalCount.toLocaleString()} total
          </span>
        </div>
      </header>

      <div className="ao-stat-row ao-stagger ao-reveal ao-reveal-2">
        <div className="ao-stat ao-stat--feature is-accent">
          <div className="ao-stat-label">
            <Database /> Total sessions
          </div>
          <div className="ao-stat-value">{totalCount.toLocaleString()}</div>
          <div className="ao-stat-meta">across the last 30 days</div>
        </div>
        <div className="ao-stat">
          <div className="ao-stat-label">
            <Layers /> On this page
          </div>
          <div className="ao-stat-value">{stats.onPage}</div>
          <div className="ao-stat-meta">
            page {page} of {pageCount}
          </div>
        </div>
        <div className="ao-stat">
          <div className="ao-stat-label">
            <AudioLines /> Voice sessions
          </div>
          <div className="ao-stat-value">
            {stats.voiceOnPage}
            <span className="suffix">/ {stats.onPage}</span>
          </div>
          <div className="ao-stat-meta">SIP &amp; audio stream</div>
        </div>
        <div className="ao-stat">
          <div className="ao-stat-label">
            <Phone /> Turns on page
          </div>
          <div className="ao-stat-value">{stats.turnsOnPage.toLocaleString()}</div>
          <div className="ao-stat-meta">conversation turns</div>
        </div>
        <div className="ao-stat">
          <div className="ao-stat-label">
            <Clock /> Avg duration
          </div>
          <div className="ao-stat-value">{avgDurationLabel}</div>
          <div className="ao-stat-meta">per session, this page</div>
        </div>
      </div>

      {error && (
        <div role="alert" className="ao-alert is-danger ao-reveal ao-reveal-3">
          <AlertTriangle />
          <span>Failed to load sessions: {error}</span>
        </div>
      )}

      <SelectionToolbar
        count={selectedCount}
        onCancel={cancelSelection}
        onDelete={() => setConfirmOpen(true)}
        className="ao-reveal ao-reveal-3"
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
          <div className="ao-empty">
            <div className="ao-empty-icon">
              <Activity />
            </div>
            <div className="ao-empty-title">No sessions match</div>
            <div className="ao-empty-text">
              Nothing came back for the current filters. Adjust the account,
              transport, or date filters above to widen the search.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {rows.map((row) => (
              <SessionCard
                key={row.id}
                row={row}
                onOpen={(sessionId) => onSessionClick?.(sessionId)}
              />
            ))}
          </div>
        )}
        <DataTablePagination table={table} totalRowCount={totalCount} />
      </div>

      <DeleteConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${selectedCount} session${selectedCount === 1 ? '' : 's'}?`}
        description={`This permanently removes the selected session${selectedCount === 1 ? '' : 's'} and any associated chat history, metrics, and recording references. This cannot be undone.`}
        deleting={deleting}
        deleteError={deleteError}
        confirmLabel={`Delete ${selectedCount}`}
        onConfirm={handleDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  )
}
