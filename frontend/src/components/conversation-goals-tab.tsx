/**
 * Conversation Goals tab — sessions of one agent judged against the
 * agent's plain-text goals (session_external_evals, source='goal').
 *
 * Header tiles use the agent-wide summary the endpoint returns (all
 * analyzed sessions, not just the page); the table is paginated and the
 * row drawer shows each goal as an accordion item with the judge's
 * reasoning and, for unmet goals, what went wrong. Self-contained: the
 * drawer + badges live in this file.
 */
import { useMemo } from 'react'
import { parseAsInteger, parseAsString, useQueryState } from 'nuqs'
import type { ColumnDef } from '@tanstack/react-table'
import { CheckCircle2, ExternalLink, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { ObsDataTable } from '@/components/data-table/obs-data-table'
import { useDataTable } from '@/components/data-table/use-data-table'
import { cn } from '@/lib/utils'
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useGoalResults } from '@/lib/observability-hooks'
import type { GoalSessionResult, GoalVerdictRow } from '@/lib/observability-types'
import { KpiTile } from '@/components/kpi'

interface ConversationGoalsTabProps {
  agentId: string
  accountId?: string | null
}

function MetBadge({ verdict }: { verdict: string }) {
  const met = verdict === 'met'
  return (
    <Badge
      variant="outline"
      className={cn(
        met
          ? 'border-success-border bg-success-bg text-success-fg'
          : 'border-destructive-border bg-destructive-bg text-destructive',
      )}
    >
      {met ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
      {met ? 'met' : 'unmet'}
    </Badge>
  )
}

/** Compact chip per goal: verdict icon + truncated goal text. */
function GoalChip({ row }: { row: GoalVerdictRow }) {
  const met = row.verdict === 'met'
  return (
    <span
      title={row.goal}
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-[1px] rounded text-[10px] whitespace-nowrap max-w-[180px]',
        met ? 'bg-success-bg text-success-fg' : 'bg-destructive-bg text-destructive',
      )}
    >
      {met ? (
        <CheckCircle2 size={10} className="shrink-0" />
      ) : (
        <XCircle size={10} className="shrink-0" />
      )}
      <span className="truncate">{row.goal}</span>
    </span>
  )
}

/** First two goal chips inline; the rest collapse into a +N hover card. */
function GoalChipsCell({ items }: { items: GoalVerdictRow[] }) {
  if (items.length === 0) return <span className="muted">—</span>
  const visible = items.slice(0, 2)
  const rest = items.slice(2)
  return (
    <div className="flex items-center gap-1.5 max-w-[320px]">
      {visible.map((g, i) => (
        <GoalChip key={`${g.goal}-${i}`} row={g} />
      ))}
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
            className="w-auto max-w-sm"
            align="start"
          >
            <div className="text-xxs-600 uppercase tracking-[0.08em] text-muted-foreground mb-2">
              All goals ({items.length})
            </div>
            <div className="flex flex-wrap gap-1">
              {items.map((g, i) => (
                <GoalChip key={`${g.goal}-${i}`} row={g} />
              ))}
            </div>
          </HoverCardContent>
        </HoverCard>
      )}
    </div>
  )
}

function GoalDetailDrawer({
  agentId,
  row,
  open,
  onOpenChange,
}: {
  agentId: string
  row: GoalSessionResult | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl" showCloseButton>
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="font-mono text-sm">{row?.session_id}</span>
            {row && (
              <Button asChild variant="ghost" size="icon" className="size-6">
                <a
                  href={`/agents/${encodeURIComponent(agentId)}/sessions/${row.session_id}`}
                  title="Open session"
                >
                  <ExternalLink size={14} />
                </a>
              </Button>
            )}
          </SheetTitle>
          <SheetDescription>
            {row
              ? `${row.met_count} met · ${row.unmet_count} unmet · ${formatDate(row.ended_at)}`
              : ''}
          </SheetDescription>
        </SheetHeader>
        {row && (
          <Accordion type="multiple" className="px-4 pb-6">
            {row.goals.map((g, i) => (
              <AccordionItem key={`${g.goal}-${i}`} value={`goal-${i}`}>
                <AccordionTrigger className="gap-2">
                  <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <span className="min-w-0 flex-1 truncate text-sm">{g.goal}</span>
                    <MetBadge verdict={g.verdict} />
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-3">
                    {g.reasoning && (
                      <div>
                        <div className="text-xxs-600 uppercase tracking-[0.08em] text-muted-foreground mb-1">
                          Reasoning
                        </div>
                        <p className="text-sm leading-relaxed">{g.reasoning}</p>
                      </div>
                    )}
                    {g.what_went_wrong && (
                      <div>
                        <div className="text-xxs-600 uppercase tracking-[0.08em] text-muted-foreground mb-1">
                          What went wrong
                        </div>
                        <p className="text-sm leading-relaxed text-destructive">
                          {g.what_went_wrong}
                        </p>
                      </div>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </SheetContent>
    </Sheet>
  )
}

export const ConversationGoalsTab = ({ agentId, accountId }: ConversationGoalsTabProps) => {
  const [page] = useQueryState('page', parseAsInteger.withDefault(1))
  const [perPage] = useQueryState('perPage', parseAsInteger.withDefault(20))
  const [detailSessionId, setDetailSessionId] = useQueryState(
    'detail',
    parseAsString.withDefault(''),
  )

  const { results, summary, meta, loading, error } = useGoalResults(
    agentId,
    perPage,
    (page - 1) * perPage,
    { accountId: accountId ?? null },
  )

  const selectedRow = useMemo(
    () =>
      detailSessionId
        ? results.find((r) => r.session_id === detailSessionId) ?? null
        : null,
    [detailSessionId, results],
  )

  const columns = useMemo<ColumnDef<GoalSessionResult>[]>(
    () => [
      {
        id: 'session_id',
        accessorKey: 'session_id',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Session" />,
        cell: ({ row }) => (
          <span className="text-xs-500 font-mono">{row.original.session_id}</span>
        ),
        enableSorting: false,
        meta: { label: 'Session' },
      },
      {
        id: 'goals',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Goals" />,
        cell: ({ row }) => <GoalChipsCell items={row.original.goals} />,
        enableSorting: false,
        meta: { label: 'Goals' },
      },
      {
        id: 'verdicts',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Met / Unmet" />,
        cell: ({ row }) => (
          <div className="flex items-center gap-2 text-xs leading-none">
            <span className="inline-flex items-center gap-1" title="met">
              <CheckCircle2 size={12} className="shrink-0 text-success-fg" />
              <span className="tabular-nums leading-none">{row.original.met_count}</span>
            </span>
            <span className="inline-flex items-center gap-1" title="unmet">
              <XCircle size={12} className="shrink-0 text-destructive" />
              <span className="tabular-nums leading-none">{row.original.unmet_count}</span>
            </span>
          </div>
        ),
        enableSorting: false,
        meta: { label: 'Met / Unmet' },
      },
      {
        id: 'duration_ms',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Duration" />,
        cell: ({ row }) =>
          row.original.duration_ms != null ? (
            <span className="tabular-nums text-xs-500">
              {formatDuration(Number(row.original.duration_ms))}
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
        header: ({ column }) => <DataTableColumnHeader column={column} label="Ended" />,
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

  // Completion rate comes from the agent-wide summary (all analyzed
  // sessions); the sparkline trends per-session completion across the
  // rows in view, oldest→newest.
  const completionSeries = useMemo(() => {
    const chronological = [...results].sort(
      (a, b) => new Date(a.ended_at).getTime() - new Date(b.ended_at).getTime(),
    )
    return chronological.map((r) => {
      const total = r.met_count + r.unmet_count
      return total > 0 ? (r.met_count / total) * 100 : 0
    })
  }, [results])

  const verdictTotal = summary.met_total + summary.unmet_total
  const completionRate = verdictTotal > 0 ? summary.met_total / verdictTotal : null

  const { table } = useDataTable({
    data: results,
    columns,
    pageCount,
    initialState: { pagination: { pageIndex: 0, pageSize: 20 } },
    getRowId: (row) => row.session_id,
  })

  return (
    <div className="flex flex-col gap-4 min-w-0">
      <div className="eval-kpi-grid">
        <KpiTile
          label="Sessions analyzed"
          value={summary.sessions_total.toLocaleString()}
          sub="sessions with goal verdicts"
        />
        <KpiTile
          label="Goal completion"
          value={completionRate != null ? `${(completionRate * 100).toFixed(0)}` : '—'}
          unit={completionRate != null ? '%' : undefined}
          sub={
            verdictTotal > 0
              ? `${summary.met_total.toLocaleString()} met · ${summary.unmet_total.toLocaleString()} unmet`
              : 'no goal verdicts yet'
          }
          sparkValues={completionSeries}
          sparkColor="var(--success)"
        />
        <KpiTile
          label="Unmet goals"
          value={summary.unmet_total.toLocaleString()}
          sub="across all analyzed sessions"
        />
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-border bg-muted px-4 py-2.5 text-sm text-foreground"
        >
          Failed to load goal results: {error}
        </div>
      )}

      <ObsDataTable
        table={table}
        toolbar={<DataTableToolbar table={table} />}
        onRowClick={(row) => setDetailSessionId(row.original.session_id)}
        totalRowCount={totalCount}
        loading={loading}
      />

      <GoalDetailDrawer
        agentId={agentId}
        row={selectedRow}
        open={!!detailSessionId}
        onOpenChange={(o) => {
          if (!o) setDetailSessionId(null)
        }}
      />
    </div>
  )
}
