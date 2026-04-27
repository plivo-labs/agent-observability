import { useMemo } from 'react'
import { parseAsArrayOf, parseAsInteger, parseAsString, useQueryState } from 'nuqs'
import type { ColumnDef } from '@tanstack/react-table'
import { AudioLines, Phone } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { ObsDataTable } from '@/components/data-table/obs-data-table'
import { useDataTable } from '@/hooks/use-data-table'
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useSessions } from '@/lib/observability-hooks'
import type { AgentSessionRow, Transport } from '@/lib/observability-types'

const TRANSPORT_OPTIONS = [
  { label: 'SIP', value: 'sip' },
  { label: 'Audio Stream', value: 'audio_stream' },
]

function TransportCell({ transport }: { transport: Transport | null }) {
  if (transport === 'sip') {
    return (
      <span className="inline-flex items-center gap-1.5 text-s-400">
        <Phone className="h-3.5 w-3.5 text-muted-foreground" />
        SIP
      </span>
    )
  }
  if (transport === 'audio_stream') {
    return (
      <span className="inline-flex items-center gap-1.5 text-s-400">
        <AudioLines className="h-3.5 w-3.5 text-muted-foreground" />
        Audio Stream
      </span>
    )
  }
  return <span className="text-muted-foreground">—</span>
}

export const SessionsPage = ({ onSessionClick }: { onSessionClick?: (sessionId: string) => void }) => {
  const [page] = useQueryState('page', parseAsInteger.withDefault(1))
  const [perPage] = useQueryState('perPage', parseAsInteger.withDefault(10))
  const [accountId] = useQueryState('account_id', parseAsString.withDefault(''))
  const [transport] = useQueryState(
    'transport',
    parseAsArrayOf(parseAsString, ',').withDefault([]),
  )
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

  const columns = useMemo<ColumnDef<AgentSessionRow>[]>(
    () => [
      {
        id: 'session_id',
        accessorKey: 'session_id',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Session ID" />,
        cell: ({ row }) => (
          <span className="text-s-400 max-w-[200px] truncate inline-block">
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
            <span className="text-s-400 text-muted-foreground max-w-[150px] truncate inline-block">
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
        id: 'transport',
        accessorKey: 'transport',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Transport" />,
        cell: ({ row }) => <TransportCell transport={row.original.transport} />,
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
          <span className="text-s-400 text-muted-foreground whitespace-nowrap">
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
          <span className="text-s-400 text-muted-foreground whitespace-nowrap">
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
        cell: ({ row }) => (
          <span className="font-mono text-s-400 tabular-nums">
            {formatDuration(row.original.duration_ms)}
          </span>
        ),
        enableSorting: false,
        meta: { label: 'Duration' },
      },
      {
        id: 'turn_count',
        accessorKey: 'turn_count',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Turns" />,
        cell: ({ row }) => (
          <span className="text-s-400 tabular-nums">{row.original.turn_count}</span>
        ),
        enableSorting: false,
        meta: { label: 'Turns' },
      },
      {
        id: 'capabilities',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Capabilities" />,
        cell: ({ row }) => (
          <div className="flex gap-1">
            {row.original.has_stt && <Badge variant="outline" className="text-xxs-400">STT</Badge>}
            {row.original.has_llm && <Badge variant="outline" className="text-xxs-400">LLM</Badge>}
            {row.original.has_tts && <Badge variant="outline" className="text-xxs-400">TTS</Badge>}
          </div>
        ),
      },
    ],
    [],
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
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-h2-600 font-semibold">Sessions</h1>
        <span className="text-s-400 text-muted-foreground">{totalCount} total</span>
      </div>

      {error && (
        <div
          role="alert"
          className="border border-border bg-muted text-foreground px-4 py-3 rounded-md mb-3 text-s-400"
        >
          Failed to load sessions: {error}
        </div>
      )}

      <ObsDataTable
        table={table}
        toolbar={<DataTableToolbar table={table} />}
        onRowClick={(row) => onSessionClick?.(row.original.session_id)}
        totalRowCount={totalCount}
        loading={loading}
      />
    </div>
  )
}
