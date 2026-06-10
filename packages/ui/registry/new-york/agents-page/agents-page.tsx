import { useMemo } from 'react'
import { parseAsInteger, parseAsString, useQueryState } from 'nuqs'
import type { ColumnDef } from '@tanstack/react-table'
import { Bot, CircleAlert } from 'lucide-react'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { ObsDataTable } from '@/components/data-table/obs-data-table'
import { useDataTable } from '@/components/data-table/use-data-table'
import { ModalityChip } from '@/components/obs-cells'
import { formatDuration } from '@/lib/observability-format'
import { useAgents } from '@/lib/observability-hooks'
import type { AgentRow } from '@/lib/observability-types'

const numberFmt = new Intl.NumberFormat()

function passRateToneClass(rate: number | null): string {
  if (rate == null) return ''
  if (rate >= 0.9) return 'text-success-fg'
  if (rate >= 0.6) return 'text-warning-fg'
  return 'text-destructive'
}

/** Inline horizontal bar showing pass-rate fill. Reused styling from the
 *  evals page's PassRateBar so the agents table feels native. */
function PassRateBar({ rate }: { rate: number | null }) {
  if (rate == null) {
    return <span className="muted">—</span>
  }
  const pct = Math.round(rate * 100)
  return (
    <div className="flex items-center gap-2 min-w-[110px]">
      <span className={'text-xs-600 tabular-nums w-10 ' + passRateToneClass(rate)}>
        {pct}%
      </span>
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden max-w-[80px]">
        <div className="h-full bg-foreground" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** "S · 5 / 24h: 1" or "—" depending on whether the agent has any sessions
 *  in either window. Compact enough to live in a narrow column. */
function SessionsCell({ row }: { row: AgentRow }) {
  if (row.session_count === 0) return <span className="muted">—</span>
  return (
    <span className="tabular-nums text-xs-500">
      {numberFmt.format(row.session_count)}
      {row.session_count_24h > 0 && (
        <span className="ml-1 text-muted-foreground">
          · {numberFmt.format(row.session_count_24h)}/24h
        </span>
      )}
    </span>
  )
}

export const AgentsPage = ({
  onAgentClick,
}: {
  /** Receives the agent_id only — callers route to `/agents/<agent_id>`.
   * Account scope isn't passed through; the detail page resolves to the
   * most-recently-active row when an agent_id spans multiple accounts. */
  onAgentClick?: (agentId: string) => void
}) => {
  // URL-synced filter state — same pattern as sessions-page/evals-page.
  // Column ids below (`agent_id`, `agent_name`, `account_id`) become URL keys.
  const [page] = useQueryState('page', parseAsInteger.withDefault(1))
  const [perPage] = useQueryState('perPage', parseAsInteger.withDefault(20))
  const [agentId] = useQueryState('agent_id', parseAsString.withDefault(''))
  const [agentName] = useQueryState('agent_name', parseAsString.withDefault(''))
  const [accountId] = useQueryState('account_id', parseAsString.withDefault(''))
  const { agents, meta, loading, error } = useAgents(
    perPage,
    (page - 1) * perPage,
    {
      agentId: agentId || undefined,
      agentName: agentName || undefined,
      accountId: accountId || undefined,
    },
  )

  const columns = useMemo<ColumnDef<AgentRow>[]>(
    () => [
      {
        // One "Agent" column: name takes the primary line when present,
        // otherwise the opaque id stands in. The id always shows as
        // small secondary text when a name is available, so deep-links
        // (URLs use agent_id) are discoverable. Column filter keeps
        // exact-match on agent_id — agent_name has its own filter
        // column below for substring search by label.
        id: 'agent_id',
        accessorKey: 'agent_id',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Agent" />,
        cell: ({ row }) => {
          const id = row.original.agent_id
          const name = row.original.agent_name
          if (!id && !name) {
            return (
              <span className="muted inline-flex items-center gap-1">
                <CircleAlert size={12} /> (unknown)
              </span>
            )
          }
          return (
            <div className="flex items-start gap-2">
              <Bot size={14} className="text-muted-foreground mt-0.5 shrink-0" />
              <div className="flex flex-col leading-tight">
                <span className="text-xs-500">{name || id}</span>
                {name && id && (
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {id}
                  </span>
                )}
              </div>
            </div>
          )
        },
        enableSorting: false,
        enableColumnFilter: true,
        meta: { label: 'Agent', placeholder: 'Exact agent_id', variant: 'text' },
      },
      {
        // Free-text substring filter on the human label. Hidden by
        // default (no `cell` rendered visibly — the column exists only
        // to expose the filter input in the toolbar).
        id: 'agent_name',
        accessorKey: 'agent_name',
        header: () => null,
        cell: () => null,
        enableSorting: false,
        enableHiding: true,
        enableColumnFilter: true,
        meta: { label: 'Name', placeholder: 'Search by name', variant: 'text' },
      },
      {
        id: 'modality',
        accessorKey: 'modality',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Modality" />,
        cell: ({ row }) => <ModalityChip value={row.original.modality} />,
        enableSorting: false,
        // No filter chip yet — the column derives from session transports
        // and the sessions table already has a Transport filter; revisit
        // if users want to scope agents to a specific modality.
        meta: { label: 'Modality' },
      },
      {
        id: 'sessions',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Sessions" />,
        cell: ({ row }) => <SessionsCell row={row.original} />,
        enableSorting: false,
        meta: { label: 'Sessions' },
      },
      {
        id: 'p95_duration_ms',
        header: ({ column }) => <DataTableColumnHeader column={column} label="p95 duration" />,
        cell: ({ row }) =>
          row.original.p95_duration_ms != null ? (
            <span className="tabular-nums text-xs-500">
              {formatDuration(row.original.p95_duration_ms)}
            </span>
          ) : (
            <span className="muted">—</span>
          ),
        enableSorting: false,
        meta: { label: 'p95 duration' },
      },
      {
        id: 'eval_pass_rate',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Pass rate" />,
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <PassRateBar rate={row.original.eval_pass_rate} />
            {row.original.eval_run_count > 0 && (
              <span className="muted text-[11px]">
                {numberFmt.format(row.original.eval_run_count)} runs
              </span>
            )}
          </div>
        ),
        enableSorting: false,
        meta: { label: 'Simulation pass rate' },
      },
      {
        id: 'account_id',
        accessorKey: 'account_id',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Account" />,
        cell: ({ row }) =>
          row.original.account_id ? (
            <span className="muted text-[11px]">{row.original.account_id}</span>
          ) : (
            <span className="muted">—</span>
          ),
        enableSorting: false,
        enableColumnFilter: true,
        meta: {
          label: 'Account',
          placeholder: 'Filter by account',
          variant: 'text',
        },
      },
    ],
    [],
  )

  const totalCount = meta.total_count
  const pageCount = Math.max(1, Math.ceil(totalCount / perPage))

  const { table } = useDataTable({
    data: agents,
    columns,
    pageCount,
    initialState: { pagination: { pageIndex: 0, pageSize: 20 } },
    // agent_id alone is the agent identity now — same id across accounts
    // merges into one row server-side.
    getRowId: (row) => row.agent_id ?? '',
  })

  return (
    <div className="w-full p-6 flex flex-col gap-4 min-w-0">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="m-0 text-2xl font-semibold">Agents</h1>
          <div className="text-sm text-muted-foreground">
            Each agent is one named LiveKit worker — its sessions, simulations,
            and conversation evals all flow through here.
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          <b className="text-foreground">{numberFmt.format(totalCount)}</b> total
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-border bg-muted px-4 py-2.5 text-sm text-foreground"
        >
          Failed to load agents: {error}
        </div>
      )}

      <ObsDataTable
        table={table}
        toolbar={<DataTableToolbar table={table} />}
        onRowClick={(row) => {
          // Only navigate when we have a real id — defensive given the
          // type is `string | null`, even though the SQL never emits null.
          if (row.original.agent_id) {
            onAgentClick?.(row.original.agent_id)
          }
        }}
        totalRowCount={totalCount}
        loading={loading}
      />
    </div>
  )
}
