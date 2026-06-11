import { useMemo } from 'react'
import { parseAsArrayOf, parseAsInteger, parseAsString, useQueryState } from 'nuqs'
import type { ColumnDef } from '@tanstack/react-table'
import { CheckCircle2, CircleAlert, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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
import { KpiTile } from '@/components/kpi'

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
          'border-success-border bg-success-bg text-success-fg',
        isFail &&
          'border-destructive-border bg-destructive-bg text-destructive',
      )}
      title={row.outcome_reason ?? undefined}
    >
      {row.outcome.replace(/^lk\./, '')}
    </Badge>
  )
}

/** Inline icon + count for each non-zero verdict bucket.
 *  `leading-none` on the count collapses its inherited line-height so
 *  the digit's optical center sits on the icon's centerline. */
function VerdictsCell({ row }: { row: ConversationEvalSummary }) {
  const total = row.pass_count + row.fail_count + row.maybe_count
  if (total === 0) return <span className="muted">—</span>
  return (
    <div className="flex items-center gap-2 text-xs leading-none">
      {row.pass_count > 0 && (
        <span className="inline-flex items-center gap-1" title="pass">
          <CheckCircle2
            size={12}
            className="shrink-0 text-success-fg"
          />
          <span className="tabular-nums leading-none">{row.pass_count}</span>
        </span>
      )}
      {row.fail_count > 0 && (
        <span className="inline-flex items-center gap-1" title="fail">
          <XCircle
            size={12}
            className="shrink-0 text-destructive"
          />
          <span className="tabular-nums leading-none">{row.fail_count}</span>
        </span>
      )}
      {row.maybe_count > 0 && (
        <span className="inline-flex items-center gap-1" title="maybe">
          <CircleAlert
            size={12}
            className="shrink-0 text-warning-fg"
          />
          <span className="tabular-nums leading-none">{row.maybe_count}</span>
        </span>
      )}
    </div>
  )
}

/** Render up to 3 chips inline; if more, hover-card overflow listing all. */
function JudgePill({ name }: { name: string }) {
  // Compact monospace chip — judges are identifiers, treated visually
  // like the other ids in the dashboard. Muted background keeps the
  // row scan-friendly without a hard border outline.
  return (
    <span className="inline-flex items-center px-1.5 py-[1px] rounded font-mono text-[10px] text-muted-foreground bg-muted whitespace-nowrap max-w-[160px] truncate">
      {name}
    </span>
  )
}

function JudgePillsCell({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="muted">—</span>
  // Single-row layout: first judge always visible, the rest collapse
  // into a compact `+N` affordance whose hover-card shows the full
  // list. Keeps the column scannable at narrow widths.
  const first = items[0]
  const rest = items.slice(1)

  return (
    <div className="flex items-center gap-1.5 max-w-[260px]">
      <JudgePill name={first} />
      {rest.length > 0 && (
        <HoverCard openDelay={120} closeDelay={80}>
          <HoverCardTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className="text-[10px] text-muted-foreground hover:text-foreground transition cursor-default whitespace-nowrap shrink-0"
            >
              +{rest.length}
            </button>
          </HoverCardTrigger>
          <HoverCardContent
            onClick={(e) => e.stopPropagation()}
            className="w-auto max-w-xs"
            align="start"
          >
            <div className="text-xxs-600 uppercase tracking-[0.08em] text-muted-foreground mb-2">
              All judges ({items.length})
            </div>
            <div className="flex flex-wrap gap-1">
              {items.map((s, i) => (
                <JudgePill key={`${s}-${i}`} name={s} />
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
          <span className="text-xs-500 font-mono">{row.original.session_id}</span>
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
          <span className="tnum" style={{ color: 'var(--ink-2)' }}>
            {formatDate(row.original.ended_at)}
          </span>
        ),
        enableSorting: false,
        meta: { label: 'Ended' },
      },
    ],
    [],
  )

  const totalCount = meta.total_count
  const pageCount = Math.max(1, Math.ceil(totalCount / perPage))

  // Verdict rollups computed across the currently-visible page. The
  // API doesn't expose a /api/agents/:id/conversation-evals/stats
  // endpoint yet, so tiles trend on whatever's loaded — usually 20
  // rows. Sparkline series sorts rows oldest→newest by ended_at so
  // the line reads left-to-right chronologically.
  const kpiStats = useMemo(() => {
    const rows = evals
    let pass = 0
    let fail = 0
    let maybe = 0
    let durationMsSum = 0
    let durationMsCount = 0
    for (const r of rows) {
      pass += r.pass_count ?? 0
      fail += r.fail_count ?? 0
      maybe += r.maybe_count ?? 0
      if (typeof r.duration_ms === 'number' && r.duration_ms > 0) {
        durationMsSum += r.duration_ms
        durationMsCount++
      } else if (typeof r.duration_ms === 'string') {
        // Bun SQL returns BIGINT as string — coerce defensively so
        // the page still produces an avg when the API hasn't been
        // patched yet to coerce server-side.
        const n = Number(r.duration_ms)
        if (Number.isFinite(n) && n > 0) {
          durationMsSum += n
          durationMsCount++
        }
      }
    }
    const totalVerdicts = pass + fail + maybe
    const passRate = totalVerdicts > 0 ? pass / totalVerdicts : null
    const avgDurationMs =
      durationMsCount > 0 ? durationMsSum / durationMsCount : null

    // Per-session pass-rate sparkline, oldest→newest.
    const chronological = [...rows].sort(
      (a, b) => new Date(a.ended_at).getTime() - new Date(b.ended_at).getTime(),
    )
    const passRateSeries = chronological.map((r) => {
      const t = (r.pass_count ?? 0) + (r.fail_count ?? 0) + (r.maybe_count ?? 0)
      return t > 0 ? ((r.pass_count ?? 0) / t) * 100 : 0
    })
    // Per-session duration sparkline (ms), oldest→newest. Coerce
    // BIGINT-string defensively in case the server-side numeric
    // coercion hasn't landed for this surface yet.
    const durationSeries = chronological.map((r) => {
      if (typeof r.duration_ms === 'number') return r.duration_ms
      if (typeof r.duration_ms === 'string') {
        const n = Number(r.duration_ms)
        return Number.isFinite(n) ? n : 0
      }
      return 0
    })

    return {
      pass,
      fail,
      maybe,
      totalVerdicts,
      passRate,
      avgDurationMs,
      passRateSeries,
      durationSeries,
    }
  }, [evals])

  const { table } = useDataTable({
    data: evals,
    columns,
    pageCount,
    initialState: { pagination: { pageIndex: 0, pageSize: 20 } },
    getRowId: (row) => row.session_id,
  })

  return (
    <div className="flex flex-col gap-4 min-w-0">
      <div className="eval-kpi-grid">
        <KpiTile
          label="Total evaluated"
          value={totalCount.toLocaleString()}
          sub="sessions with eval data"
        />
        <KpiTile
          label="Pass rate"
          value={kpiStats.passRate != null ? `${(kpiStats.passRate * 100).toFixed(0)}` : '—'}
          unit={kpiStats.passRate != null ? '%' : undefined}
          sub={
            kpiStats.totalVerdicts > 0
              ? `${kpiStats.pass} pass · ${kpiStats.fail} fail · ${kpiStats.maybe} maybe (in view)`
              : 'no verdicts in view'
          }
          sparkValues={kpiStats.passRateSeries}
          sparkColor="var(--success)"
        />
        <KpiTile
          label="Avg duration (in view)"
          value={
            kpiStats.avgDurationMs != null
              ? formatDuration(Math.round(kpiStats.avgDurationMs))
              : '—'
          }
          sub={
            kpiStats.avgDurationMs != null
              ? `${evals.length} of ${totalCount.toLocaleString()} sessions`
              : 'no data'
          }
          sparkValues={kpiStats.durationSeries}
          sparkColor="var(--warning)"
        />
      </div>

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
