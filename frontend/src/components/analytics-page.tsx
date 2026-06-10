import { useMemo, useState } from 'react'
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs'
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  bucketTickFormatter,
  formatCost,
  formatMsExact,
  formatPercent,
} from '@/lib/observability-format'
import { useFleetStats } from '@/lib/observability-hooks'
import type { AgentStatsRange, FleetStats } from '@/lib/observability-types'
import { KpiTile } from '@/components/kpi'
import { TimeSeriesCard } from '@/components/observability-chart-shared'

const numberFmt = new Intl.NumberFormat()

// Same palette as agent-overview-tab so fleet and per-agent views read
// as one product.
const COLORS = {
  accent: '#60a5fa',
  warn: '#fbbf24',
  bad: '#f87171',
  pie: ['#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#fb923c', '#22d3ee', '#94a3b8'],
}

const RANGES: AgentStatsRange[] = ['24h', '7d', '30d']

const chartTooltipStyle = {
  background: 'var(--background)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
}

export const AnalyticsPage = ({
  onAgentClick,
}: {
  onAgentClick?: (agentId: string) => void
}) => {
  const [rangeRaw, setRange] = useQueryState(
    'range',
    parseAsStringEnum<AgentStatsRange>(['24h', '7d', '30d']).withDefault('7d'),
  )
  const [accountId, setAccountId] = useQueryState('account_id', parseAsString.withDefault(''))
  // Commit-on-Enter so each keystroke doesn't refire the (heavy) fleet query.
  const [accountDraft, setAccountDraft] = useState(accountId)

  const range = rangeRaw as AgentStatsRange
  const { stats, loading, error } = useFleetStats(range, accountId || null)

  const xTickFormatter = useMemo(() => bucketTickFormatter(range), [range])

  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-lg font-semibold">Analytics</h1>
      <div className="flex-1" />
      <Input
        value={accountDraft}
        placeholder="Filter account id… (Enter)"
        className="h-8 w-56"
        onChange={(e) => setAccountDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setAccountId(accountDraft || null)
        }}
        onBlur={() => setAccountId(accountDraft || null)}
      />
      <div className="flex overflow-hidden rounded-md border">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRange(r)}
            className={
              'px-3 py-1.5 text-xs font-medium transition-colors ' +
              (range === r
                ? 'bg-foreground text-background'
                : 'bg-card text-muted-foreground hover:text-foreground')
            }
          >
            {r}
          </button>
        ))}
      </div>
    </div>
  )

  if (error) {
    return (
      <div className="space-y-4">
        {header}
        <div
          role="alert"
          className="rounded-lg border border-border bg-muted px-4 py-2.5 text-sm text-foreground"
        >
          Failed to load stats: {error}
        </div>
      </div>
    )
  }

  if (loading || !stats) {
    return (
      <div className="space-y-4">
        {header}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  return <FleetStatsBody stats={stats} header={header} range={range} xTickFormatter={xTickFormatter} onAgentClick={onAgentClick} />
}

const FleetStatsBody = ({
  stats,
  header,
  range,
  xTickFormatter,
  onAgentClick,
}: {
  stats: FleetStats
  header: React.ReactNode
  range: AgentStatsRange
  xTickFormatter: (iso: string) => string
  onAgentClick?: (agentId: string) => void
}) => {
  const hasData = stats.total_sessions > 0

  const passRateBarVariant = (rate: number | null): 'pass' | 'warn' | 'fail' | undefined => {
    if (rate == null) return undefined
    if (rate >= 90) return 'pass'
    if (rate >= 60) return 'warn'
    return 'fail'
  }
  // Interruption rate is a "lower is better" metric — invert the tone bands.
  const interruptionBarVariant = (rate: number | null): 'pass' | 'warn' | 'fail' | undefined => {
    if (rate == null) return undefined
    if (rate <= 10) return 'pass'
    if (rate <= 25) return 'warn'
    return 'fail'
  }

  const llmRatePct = stats.llm_pass_rate != null ? stats.llm_pass_rate * 100 : null
  const outcomeRatePct = stats.outcome_success_rate != null ? stats.outcome_success_rate * 100 : null
  const interruptionPct = stats.interruption_rate != null ? stats.interruption_rate * 100 : null

  const sessionSeries = stats.buckets.map((b) => b.session_count)
  const costSeries = stats.buckets.map((b) => b.estimated_cost_usd ?? 0)
  const p95Series = stats.buckets.map((b) => b.p95_user_perceived_ms ?? 0)
  const p95Bad = stats.p95_user_perceived_ms != null && stats.p95_user_perceived_ms > 2000

  // Recharts needs a numeric field for the rate line; precompute percent.
  const bucketsWithPct = stats.buckets.map((b) => ({
    ...b,
    interruption_pct:
      b.interruption_rate != null ? Math.round(b.interruption_rate * 1000) / 10 : null,
  }))

  return (
    <div className="space-y-4">
      {header}

      <div className="eval-kpi-grid">
        <KpiTile
          label="Sessions"
          value={numberFmt.format(stats.total_sessions)}
          sub={`${numberFmt.format(stats.active_agents)} active agents`}
          sparkValues={sessionSeries}
          sparkColor="var(--accent-purple)"
        />
        <KpiTile
          label="Total LLM cost"
          value={formatCost(stats.total_estimated_cost_usd)}
          sub={`priced on token usage · ${range}`}
          sparkValues={costSeries}
          sparkColor="var(--warning)"
        />
        <KpiTile
          label="p95 perceived latency"
          value={formatMsExact(stats.p95_user_perceived_ms)}
          sub={`p50 ${formatMsExact(stats.p50_user_perceived_ms)} · p99 ${formatMsExact(stats.p99_user_perceived_ms)}`}
          sparkValues={p95Series}
          sparkColor={p95Bad ? 'var(--destructive)' : 'var(--info)'}
        />
        <KpiTile
          label="Interruption rate"
          value={formatPercent(stats.interruption_rate)}
          sub="interrupted agent turns"
          barPct={interruptionPct ?? undefined}
          barVariant={interruptionBarVariant(interruptionPct)}
        />
        <KpiTile
          label="LLM judge pass rate"
          value={formatPercent(stats.llm_pass_rate)}
          sub="conversation-level judges"
          barPct={llmRatePct ?? undefined}
          barVariant={passRateBarVariant(llmRatePct)}
        />
        <KpiTile
          label="Outcome success rate"
          value={formatPercent(stats.outcome_success_rate)}
          sub="latest outcome per session"
          barPct={outcomeRatePct ?? undefined}
          barVariant={passRateBarVariant(outcomeRatePct)}
        />
      </div>

      {!hasData ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          No sessions in the selected range.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <TimeSeriesCard
              title="Sessions over time"
              data={stats.buckets}
              dataKey="session_count"
              kind="bar"
              color={COLORS.accent}
              xTickFormatter={xTickFormatter}
              allowDecimals={false}
            />
            <TimeSeriesCard
              title="p95 perceived latency (ms)"
              data={stats.buckets}
              dataKey="p95_user_perceived_ms"
              kind="line"
              color={COLORS.bad}
              xTickFormatter={xTickFormatter}
              valueFormatter={(v) => `${v} ms`}
              valueLabel="p95"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <TimeSeriesCard
              title="LLM cost over time"
              data={stats.buckets}
              dataKey="estimated_cost_usd"
              kind="area"
              color={COLORS.warn}
              xTickFormatter={xTickFormatter}
              yTickFormatter={(v) => formatCost(Number(v))}
              valueFormatter={(v) => formatCost(Number(v))}
              valueLabel="cost"
            />
            <TimeSeriesCard
              title="Interruption rate (%)"
              data={bucketsWithPct}
              dataKey="interruption_pct"
              kind="line"
              color={COLORS.warn}
              xTickFormatter={xTickFormatter}
              valueFormatter={(v) => `${v}%`}
              valueLabel="interruptions"
              yUnit="%"
              connectNulls
            />
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-medium">Top agents by volume</CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                {stats.agent_breakdown.length === 0 ? (
                  <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
                    No agents in the last {range}
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="py-1.5 pr-2 font-medium">Agent</th>
                        <th className="py-1.5 pr-2 text-right font-medium">Sessions</th>
                        <th className="py-1.5 pr-2 text-right font-medium">p95</th>
                        <th className="py-1.5 pr-2 text-right font-medium">Interrupts</th>
                        <th className="py-1.5 pr-2 text-right font-medium">Success</th>
                        <th className="py-1.5 text-right font-medium">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.agent_breakdown.map((a) => (
                        <tr
                          key={a.agent_id ?? '(unattributed)'}
                          className={
                            'border-b last:border-0' +
                            (a.agent_id && onAgentClick
                              ? ' cursor-pointer hover:bg-muted/50'
                              : '')
                          }
                          onClick={() => a.agent_id && onAgentClick?.(a.agent_id)}
                        >
                          <td className="max-w-[180px] truncate py-1.5 pr-2">
                            {a.agent_name || a.agent_id || '(unattributed)'}
                          </td>
                          <td className="py-1.5 pr-2 text-right tabular-nums">
                            {numberFmt.format(a.session_count)}
                          </td>
                          <td className="py-1.5 pr-2 text-right tabular-nums">
                            {a.p95_user_perceived_ms != null ? `${a.p95_user_perceived_ms}ms` : '—'}
                          </td>
                          <td className="py-1.5 pr-2 text-right tabular-nums">
                            {formatPercent(a.interruption_rate)}
                          </td>
                          <td className="py-1.5 pr-2 text-right tabular-nums">
                            {formatPercent(a.outcome_success_rate)}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">
                            {formatCost(a.estimated_cost_usd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-medium">Sessions by account</CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                {stats.account_breakdown.length === 0 ? (
                  <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
                    No account data in the last {range}
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie
                        data={stats.account_breakdown}
                        dataKey="session_count"
                        nameKey={(d: { account_id: string | null }) => d.account_id ?? '(none)'}
                        innerRadius={50}
                        outerRadius={85}
                        paddingAngle={2}
                      >
                        {stats.account_breakdown.map((_, i) => (
                          <Cell key={i} fill={COLORS.pie[i % COLORS.pie.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={chartTooltipStyle}
                        formatter={(v, name) => [`${v} sessions`, name]}
                      />
                      <Legend
                        verticalAlign="bottom"
                        wrapperStyle={{ fontSize: 11 }}
                        formatter={(value) => (
                          <span className="text-muted-foreground">{value}</span>
                        )}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
