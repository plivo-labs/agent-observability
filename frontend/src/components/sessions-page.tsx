import { useMemo } from 'react'
import { parseAsArrayOf, parseAsInteger, parseAsString, useQueryState } from 'nuqs'
import type { ColumnDef } from '@tanstack/react-table'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { ObsDataTable } from '@/components/data-table/obs-data-table'
import { useDataTable } from '@/hooks/use-data-table'
import { formatDate } from '@/lib/observability-format'
import { useSessions } from '@/lib/observability-hooks'
import type { AgentSessionRow } from '@/lib/observability-types'
import { CapsChips, DurationCell, TransportPill, TurnsBar } from '@/components/obs-cells'

const TRANSPORT_OPTIONS = [
  { label: 'SIP', value: 'sip' },
  { label: 'Audio Stream', value: 'audio_stream' },
]

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
  // Date-range filter emits [fromMs, toMs] as stringified epoch ms.
  const [startedAt] = useQueryState(
    'started_at',
    parseAsArrayOf(parseAsString, ',').withDefault([]),
  )
  const startedFromIso = useMemo(() => {
    const v = startedAt[0]
    if (!v) return undefined
    const d = new Date(Number(v))
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }, [startedAt])
  const startedToIso = useMemo(() => {
    const v = startedAt[1]
    if (!v) return undefined
    const d = new Date(Number(v))
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }, [startedAt])

  const { sessions, meta, loading, error } = useSessions(
    Math.min(perPage, 20),
    (page - 1) * Math.min(perPage, 20),
    {
      accountId: accountId || undefined,
      startedFrom: startedFromIso,
      startedTo: startedToIso,
      transport: transport.length ? transport : undefined,
    },
  )

  // Fill-bar width in the Turns cell is relative to the largest turn count
  // on the current page.
  const maxTurns = useMemo(
    () => sessions.reduce((m, s) => Math.max(m, s.turn_count), 1),
    [sessions],
  )

  const columns = useMemo<ColumnDef<AgentSessionRow>[]>(
    () => [
      {
        id: 'session_id',
        accessorKey: 'session_id',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Session ID" />,
        cell: ({ row }) => (
          <span className="mono">{row.original.session_id}</span>
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
          <span className="tnum" style={{ color: 'hsl(var(--secondary))' }}>
            {formatDate(row.original.started_at)}
          </span>
        ),
        enableSorting: false,
        enableColumnFilter: true,
        meta: { label: 'Started', variant: 'dateRange' },
      },
      {
        id: 'ended_at',
        accessorKey: 'ended_at',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Ended" />,
        cell: ({ row }) => (
          <span className="tnum" style={{ color: 'hsl(var(--secondary))' }}>
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
        id: 'turn_count',
        accessorKey: 'turn_count',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Turns" />,
        cell: ({ row }) => <TurnsBar turns={row.original.turn_count} maxTurns={maxTurns} />,
        enableSorting: false,
        meta: { label: 'Turns' },
      },
      {
        id: 'capabilities',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Capabilities" />,
        cell: ({ row }) => (
          <CapsChips
            stt={row.original.has_stt}
            llm={row.original.has_llm}
            tts={row.original.has_tts}
          />
        ),
      },
    ],
    [maxTurns],
  )

  const totalCount = meta.total_count
  const pageCount = Math.max(1, Math.ceil(totalCount / perPage))

  const { table } = useDataTable({
    data: sessions,
    columns,
    pageCount,
    initialState: { pagination: { pageIndex: 0, pageSize: 10 } },
    getRowId: (row) => row.session_id,
  })

  return (
    <>
      <div className="obs-head">
        <div>
          <h1>Sessions</h1>
          <div className="sub">Every agent session captured in the last 30 days.</div>
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
          Failed to load sessions: {error}
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
        onRowClick={(row) => onSessionClick?.(row.original.session_id)}
      />
    </>
  )
}
