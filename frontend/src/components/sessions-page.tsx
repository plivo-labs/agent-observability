import { useMemo, useState } from 'react'
import { parseAsArrayOf, parseAsInteger, parseAsString, useQueryState } from 'nuqs'
import type { ColumnDef, Row, Table } from '@tanstack/react-table'
import {
  Activity,
  AlertTriangle,
  AudioLines,
  Clock,
  Database,
  Layers,
  Phone,
  Trash2,
} from 'lucide-react'
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
import { useSessions } from '@/lib/observability-hooks'
import { useObservabilityContext } from '@/lib/observability-provider'
import type { AgentSessionRow } from '@/lib/observability-types'
import { CapsChips, DurationCell, TransportPill } from '@/components/obs-cells'

// Transport filter options. Must mirror the values that actually land in
// `agent_transport_sessions.transport` — real Live/Truman calls persist as
// `phone`, text sims as `text` — otherwise the filter never matches a row.
const TRANSPORT_OPTIONS = [
  { label: 'Phone', value: 'phone' },
  { label: 'SIP', value: 'sip' },
  { label: 'Audio Stream', value: 'audio_stream' },
  { label: 'Text', value: 'text' },
]

// Human label for the neutral status pill. Transport when present, else state.
const TRANSPORT_LABELS: Record<string, string> = {
  sip: 'SIP',
  audio_stream: 'Audio Stream',
  text: 'Text',
  terminal_text: 'Terminal Text',
  phone: 'Phone',
}

// Shared column layout. The header row and every data/skeleton row consume the
// SAME width classes here so the labels can't drift out of alignment with the
// cells beneath them. Order mirrors the rendered cells in `SessionCard`:
//   (checkbox) · Session · Pipeline · Started · Turns · Duration · Transport
const COL = {
  select: 'flex w-4 shrink-0 items-center',
  // SESSION gets a healthy share but is capped so it can't swallow the row and
  // leave a void before PIPELINE. A flexible spacer (COL.spacer) absorbs any
  // leftover width on very wide viewports, keeping the data columns grouped.
  session: 'min-w-0 flex-1 max-w-[360px]',
  // Invisible elastic gap — soaks up extra width so the columns stay balanced
  // instead of one column stretching. Not rendered as a visible header label.
  spacer: 'hidden flex-1 lg:block',
  pipeline: 'hidden w-[180px] shrink-0 overflow-hidden lg:block',
  started: 'hidden w-[168px] shrink-0 truncate whitespace-nowrap sm:block',
  turns: 'w-[80px] shrink-0 whitespace-nowrap text-right',
  duration: 'w-[72px] shrink-0 whitespace-nowrap text-right',
  transport: 'w-[104px] shrink-0',
} as const

// Subtle, on-theme column header — small uppercase mono labels with a bottom
// border, matching the Neo/Truman `.ao-stat-label` aesthetic. Reads as headers,
// not as another data row. Carries the select-all checkbox in the first slot.
function SessionListHeader({
  table,
}: {
  table: Table<AgentSessionRow>
}) {
  const labelCls =
    'text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80'
  return (
    <div
      className="flex items-center gap-3 border-b border-border px-3 pb-1.5"
      style={{ fontFamily: 'var(--mono)' }}
    >
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
      <span className={cn(COL.session, labelCls)}>Session</span>
      <span className={COL.spacer} aria-hidden />
      <span className={cn(COL.pipeline, labelCls)}>Pipeline</span>
      <span className={cn(COL.started, labelCls)}>Started</span>
      <span className={cn(COL.turns, labelCls)}>Turns</span>
      <span className={cn(COL.duration, labelCls)}>Duration</span>
      <span className={cn(COL.transport, labelCls)}>Transport</span>
    </div>
  )
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
  const pill = session.transport
    ? TRANSPORT_LABELS[session.transport] ?? session.transport
    : session.state
  const textOnly = session.transport === 'text' || session.transport === 'terminal_text'

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        const t = e.target as HTMLElement
        if (t.closest('button, a, input, select, [role="menuitem"]')) return
        onOpen(session.session_id)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(session.session_id)
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
          aria-label={`Select session ${session.session_id}`}
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
      <div className={cn(COL.session, 'flex items-center gap-2')}>
        <span className="truncate text-sm text-foreground" style={{ fontFamily: 'var(--font-display)' }}>
          {title}
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70" style={{ fontFamily: 'var(--mono)' }}>
          {idShort}
        </span>
      </div>
      <div className={COL.spacer} aria-hidden />
      <div className={COL.pipeline}>
        <CapsChips
          stt={!textOnly && session.has_stt}
          llm={session.has_llm}
          tts={!textOnly && session.has_tts}
        />
      </div>
      <span className={cn(COL.started, 'truncate text-[10px] uppercase tracking-[0.12em] text-muted-foreground')} style={{ fontFamily: 'var(--mono)' }} title={formatDate(session.started_at)}>
        {formatDate(session.started_at)}
      </span>
      <span className={cn(COL.turns, 'text-[10px] uppercase tracking-[0.16em] text-muted-foreground')} style={{ fontFamily: 'var(--mono)' }}>
        {session.turn_count} {session.turn_count === 1 ? 'turn' : 'turns'}
      </span>
      <span className={cn(COL.duration, 'text-[10px] tabular-nums text-muted-foreground')} style={{ fontFamily: 'var(--mono)' }}>
        {formatDuration(session.duration_ms)}
      </span>
      <span className={cn(COL.transport, 'truncate rounded-full border px-2 py-0.5 text-center text-[10px] font-medium uppercase tracking-wide bg-muted text-muted-foreground border-border')}>
        {pill}
      </span>
    </div>
  )
}

function SessionCardSkeleton() {
  return (
    <div
      className="flex items-center gap-3 border bg-card px-3 py-2"
      style={{ borderRadius: 'var(--radius)' }}
    >
      <div className={COL.select}>
        <Skeleton className="h-4 w-4" />
      </div>
      <Skeleton className={cn(COL.session, 'h-4')} />
      <div className={COL.spacer} aria-hidden />
      <div className={COL.pipeline}>
        <Skeleton className="h-4 w-[120px]" />
      </div>
      <Skeleton className={cn(COL.started, 'h-3')} />
      <Skeleton className={cn(COL.turns, 'h-3')} />
      <Skeleton className={cn(COL.duration, 'h-3')} />
      <Skeleton className={cn(COL.transport, 'h-5 rounded-full')} />
    </div>
  )
}

export const SessionsPage = ({ onSessionClick }: { onSessionClick?: (sessionId: string) => void }) => {
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
  // string. We expand it server-side into a 00:00 → next-midnight window so
  // the query returns every session that started during that calendar day.
  //
  // The `started_at` URL key is owned by `useDataTable` (the toolbar's date
  // picker writes it). That column has no `meta.options`, so `useDataTable`
  // registers it with a *single-string* parser and serializes the picked epoch
  // ms as a plain string. We must read it back with the SAME `parseAsString`
  // shape — registering a second hook with a different parser (e.g.
  // `parseAsArrayOf`) makes the two nuqs hooks disagree on the key's
  // serialization and the picked value never lands in the URL.
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

      {selectedCount > 0 && (
        <div className="ao-toolbar ao-reveal ao-reveal-3">
          <span className="ao-badge is-accent">
            <b>{selectedCount}</b>&nbsp;selected
          </span>
          <span className="ao-toolbar-spacer" />
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
      )}

      <div className="ao-reveal ao-reveal-3 flex flex-col gap-2.5">
        <DataTableToolbar table={table} />
        {loading && rows.length === 0 ? (
          <div className="flex flex-col gap-1.5">
            <SessionListHeader table={table} />
            {Array.from({ length: 5 }).map((_, i) => (
              <SessionCardSkeleton key={`sk-${i}`} />
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
          <div className="flex flex-col gap-1.5">
            <SessionListHeader table={table} />
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
