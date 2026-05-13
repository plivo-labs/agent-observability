import { useMemo } from 'react'
import { parseAsArrayOf, parseAsInteger, parseAsString, useQueryState } from 'nuqs'
import type { ColumnDef } from '@tanstack/react-table'
import { CheckCircle2, CircleAlert, ExternalLink, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { ObsDataTable } from '@/components/data-table/obs-data-table'
import { useDataTable } from '@/components/data-table/use-data-table'
import { cn } from '@/lib/utils'
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useConversationEvals } from '@/lib/observability-hooks'
import type { ConversationEvalSummary } from '@/lib/observability-types'
import { ConversationEvalDetailDrawer } from '@/components/conversation-eval-detail-drawer'

interface ConversationEvalsTabProps {
  agentId: string
  accountId?: string | null
}

/** Outcome chip styled like the existing pass/fail tone tokens. */
function OutcomeCell({ row }: { row: ConversationEvalSummary }) {
  if (!row.outcome) return <span className="muted">—</span>
  const isSuccess = row.outcome === 'lk.success' || row.outcome === 'success'
  const isFail = row.outcome === 'lk.fail' || row.outcome === 'fail'
  return (
    <Badge
      variant="outline"
      className={cn(
        'capitalize',
        isSuccess &&
          'border-[hsl(var(--success-border))] bg-[hsl(var(--success-bg))] text-[hsl(var(--success-fg,var(--success)))]',
        isFail &&
          'border-[hsl(var(--destructive-border))] bg-[hsl(var(--destructive-bg))] text-[hsl(var(--destructive))]',
      )}
      title={row.outcome_reason ?? undefined}
    >
      {row.outcome.replace(/^lk\./, '')}
    </Badge>
  )
}

/** Inline icon + count for each non-zero verdict bucket. */
function VerdictsCell({ row }: { row: ConversationEvalSummary }) {
  const total = row.pass_count + row.fail_count + row.maybe_count
  if (total === 0) return <span className="muted">—</span>
  return (
    <div className="flex items-center gap-2 text-xs">
      {row.pass_count > 0 && (
        <span className="inline-flex items-center gap-0.5" title="pass">
          <CheckCircle2
            size={12}
            className="text-[hsl(var(--success-fg,var(--success)))]"
          />
          <span className="tabular-nums">{row.pass_count}</span>
        </span>
      )}
      {row.fail_count > 0 && (
        <span className="inline-flex items-center gap-0.5" title="fail">
          <XCircle size={12} className="text-[hsl(var(--destructive))]" />
          <span className="tabular-nums">{row.fail_count}</span>
        </span>
      )}
      {row.maybe_count > 0 && (
        <span className="inline-flex items-center gap-0.5" title="maybe">
          <CircleAlert
            size={12}
            className="text-[hsl(var(--warning-fg,var(--warning)))]"
          />
          <span className="tabular-nums">{row.maybe_count}</span>
        </span>
      )}
    </div>
  )
}

/** Render up to 3 chips inline; if more, hover-card overflow listing all. */
function JudgePillsCell({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="muted">—</span>
  // Cap visible chips at 2 — keeps the column width predictable; rest
  // go to the +N more hover-card.
  const visible = items.slice(0, 2)
  const overflow = items.slice(2)

  return (
    <div className="flex flex-wrap items-center gap-1 max-w-[240px]">
      {visible.map((s, i) => (
        <Badge key={`${s}-${i}`} variant="outline" className="text-[10px]">
          {s}
        </Badge>
      ))}
      {overflow.length > 0 && (
        <HoverCard openDelay={120} closeDelay={80}>
          <HoverCardTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className="text-[10px] text-muted-foreground hover:text-foreground transition cursor-default"
            >
              +{overflow.length} more
            </button>
          </HoverCardTrigger>
          <HoverCardContent
            onClick={(e) => e.stopPropagation()}
            className="w-auto max-w-xs"
            align="start"
          >
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
              All judges ({items.length})
            </div>
            <div className="flex flex-wrap gap-1">
              {items.map((s, i) => (
                <Badge key={`${s}-${i}`} variant="outline" className="text-[10px]">
                  {s}
                </Badge>
              ))}
            </div>
          </HoverCardContent>
        </HoverCard>
      )}
    </div>
  )
}

export const ConversationEvalsTab = ({
  agentId,
  accountId,
}: ConversationEvalsTabProps) => {
  const [page] = useQueryState('page', parseAsInteger.withDefault(1))
  const [perPage] = useQueryState('perPage', parseAsInteger.withDefault(20))
  // URL-syncs which session's drawer is open. Drawer is the "sidebar"
  // where judges (now accordions) live.
  const [detailSessionId, setDetailSessionId] = useQueryState(
    'detail',
    parseAsString.withDefault(''),
  )
  // Table-toolbar filters. Plug into the same hook that drives the
  // table so paging + filters are URL-shared. Multi-select chips emit
  // the filter value as a comma-joined array (see use-data-table.ts's
  // onColumnFiltersChange) — `failed` is structurally a multi-select
  // even though only one option exists ('true' = "show failed only"),
  // so we read it as an array and check inclusion.
  const [sessionIdFilter] = useQueryState('session_id', parseAsString.withDefault(''))
  const [failedFilter] = useQueryState(
    'failed',
    parseAsArrayOf(parseAsString, ',').withDefault([]),
  )

  const { evals, meta, loading, error } = useConversationEvals(
    agentId,
    perPage,
    (page - 1) * perPage,
    {
      accountId: accountId ?? null,
      sessionId: sessionIdFilter || null,
      failedOnly: failedFilter.includes('true'),
    },
  )

  const selectedRow = useMemo(
    () =>
      detailSessionId
        ? evals.find((r) => r.session_id === detailSessionId) ?? null
        : null,
    [detailSessionId, evals],
  )

  const columns = useMemo<ColumnDef<ConversationEvalSummary>[]>(
    () => [
      {
        id: 'session_id',
        accessorKey: 'session_id',
        header: ({ column }) => (
          <DataTableColumnHeader column={column} label="Session" />
        ),
        cell: ({ row }) => (
          <span className="text-xs-500">{row.original.session_id}</span>
        ),
        enableSorting: false,
        enableColumnFilter: true,
        meta: {
          label: 'Session',
          placeholder: 'Substring match on session_id',
          variant: 'text',
        },
      },
      {
        id: 'failed',
        accessorKey: 'fail_count',
        header: ({ column }) => (
          <DataTableColumnHeader column={column} label="Outcome" />
        ),
        cell: ({ row }) => <OutcomeCell row={row.original} />,
        enableSorting: false,
        enableColumnFilter: true,
        // The URL key is `failed` (matches the obs query-param). Single-
        // option multi-select: turn this on to scope to failing sessions.
        meta: {
          label: 'Failed only',
          variant: 'multiSelect',
          options: [{ label: 'Show failed', value: 'true' }],
        },
      },
      {
        id: 'verdicts',
        header: ({ column }) => (
          <DataTableColumnHeader column={column} label="Verdicts" />
        ),
        cell: ({ row }) => <VerdictsCell row={row.original} />,
        enableSorting: false,
        meta: { label: 'Verdicts' },
      },
      {
        id: 'judges',
        header: ({ column }) => (
          <DataTableColumnHeader column={column} label="Judges" />
        ),
        cell: ({ row }) => <JudgePillsCell items={row.original.judge_names} />,
        enableSorting: false,
        meta: { label: 'Judges' },
      },
      {
        id: 'duration_ms',
        header: ({ column }) => (
          <DataTableColumnHeader column={column} label="Duration" />
        ),
        cell: ({ row }) =>
          row.original.duration_ms != null ? (
            <span className="tabular-nums text-xs-500">
              {formatDuration(row.original.duration_ms)}
            </span>
          ) : (
            <span className="muted">—</span>
          ),
        enableSorting: false,
        meta: { label: 'Duration' },
      },
      {
        id: 'ended_at',
        accessorKey: 'ended_at',
        header: ({ column }) => (
          <DataTableColumnHeader column={column} label="Ended" />
        ),
        cell: ({ row }) => (
          <span className="tnum" style={{ color: 'hsl(var(--secondary))' }}>
            {formatDate(row.original.ended_at)}
          </span>
        ),
        enableSorting: false,
        meta: { label: 'Ended' },
      },
      {
        // Explicit "Open session" action — bypasses the drawer and goes
        // straight to the full session detail page.
        id: 'open_session',
        header: () => null,
        cell: ({ row }) => (
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <a
              href={`/sessions/${row.original.session_id}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="Open full session detail (new tab)"
            >
              <ExternalLink size={12} />
              Open
            </a>
          </Button>
        ),
        enableSorting: false,
        enableHiding: false,
        size: 80,
      },
    ],
    [],
  )

  const totalCount = meta.total_count
  const pageCount = Math.max(1, Math.ceil(totalCount / perPage))

  const { table } = useDataTable({
    data: evals,
    columns,
    pageCount,
    initialState: { pagination: { pageIndex: 0, pageSize: 20 } },
    getRowId: (row) => row.session_id,
  })

  return (
    <div className="flex flex-col gap-4 min-w-0">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-border bg-muted px-4 py-2.5 text-sm text-foreground"
        >
          Failed to load conversation evals: {error}
        </div>
      )}

      <ObsDataTable
        table={table}
        toolbar={<DataTableToolbar table={table} />}
        // Primary click opens the side drawer where judges are
        // accordion items.
        onRowClick={(row) => setDetailSessionId(row.original.session_id)}
        totalRowCount={totalCount}
        loading={loading}
      />

      <ConversationEvalDetailDrawer
        row={selectedRow}
        open={!!detailSessionId}
        onOpenChange={(o) => {
          if (!o) setDetailSessionId(null)
        }}
      />
    </div>
  )
}
