import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatCost, formatDuration } from '@/lib/observability-format'
import { useAgentStats } from '@/lib/observability-hooks'
import type { AgentStatsRange } from '@/lib/observability-types'
import { KpiTile } from '@/components/kpi'

interface AgentOverviewTabProps {
  agentId: string
  range: AgentStatsRange
}

const numberFmt = new Intl.NumberFormat()

function formatPct(value: number | null | undefined): string {
  if (value == null) return '—'
  return `${Math.round(value * 100)}%`
}

function formatMs(value: number | null | undefined): string {
  if (value == null) return '—'
  return `${numberFmt.format(value)} ms`
}

// Color palette pulled from the existing chart files so this dashboard
// feels visually consistent with the per-session detail.
const COLORS = {
  primary: 'hsl(var(--foreground))',
  accent: '#60a5fa',
  warn: '#fbbf24',
  bad: '#f87171',
  good: '#34d399',
  muted: 'hsl(var(--muted-foreground))',
  pie: ['#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#fb923c', '#22d3ee', '#94a3b8'],
}

export const AgentOverviewTab = ({ agentId, range }: AgentOverviewTabProps) => {
  const { stats, loading, error } = useAgentStats(agentId, range)

  // Bucket axis labels: trim ISO timestamps to HH:MM (or MM-DD for 30d range)
  // so the X axis stays readable. Recharts hands us the raw bucket_start
  // string and the formatter runs on tick render.
  const xTickFormatter = useMemo(() => {
    if (range === '30d') {
      return (iso: string) => {
        const d = new Date(iso)
        return `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d
          .getDate()
          .toString()
          .padStart(2, '0')}`
      }
    }
    return (iso: string) => {
      const d = new Date(iso)
      return `${d.getHours().toString().padStart(2, '0')}:${d
        .getMinutes()
        .toString()
        .padStart(2, '0')}`
    }
  }, [range])

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-border bg-muted px-4 py-2.5 text-sm text-foreground"
      >
        Failed to load stats: {error}
      </div>
    )
  }

  if (loading || !stats) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  const hasData = stats.total_sessions > 0
  const llmRatePct =
    stats.llm_pass_rate != null ? stats.llm_pass_rate * 100 : null
  const ciRatePct =
    stats.ci_pass_rate != null ? stats.ci_pass_rate * 100 : null
  const passRateBarVariant = (
    rate: number | null,
  ): 'pass' | 'warn' | 'fail' | undefined => {
    if (rate == null) return undefined
    if (rate >= 90) return 'pass'
    if (rate >= 60) return 'warn'
    return 'fail'
  }
  // Sparkline series straight out of the time-bucketed agent stats —
  // same source the Sessions tab tiles use, so volume/latency lines
  // read identically across surfaces. Pass rates aren't bucketed
  // server-side, so those tiles show a tone-coloured `barPct` instead
  // of a spark.
  const sessionSeries = stats.buckets.map((b) => b.session_count)
  const p95Series = stats.buckets.map((b) => b.p95_user_perceived_ms ?? 0)
  const costSeries = stats.buckets.map((b) => b.estimated_cost_usd ?? 0)

  // Render-only tone strings (red P95 when latency is bad, like
  // .metric-tile.bad on the session-detail page).
  const p95Bad =
    stats.p95_user_perceived_ms != null &&
    stats.p95_user_perceived_ms > 2000

  return (
    <div className="space-y-4">
      {/* KPI row — visual language matches the Simulation Evals tab:
       *   purple sparkline for volume, blue for latency, green/amber/red
       *   barPct fill for pass-rate tiles. */}
      <div className="eval-kpi-grid">
        <KpiTile
          label="Sessions"
          value={numberFmt.format(stats.total_sessions)}
          sub={`avg ${stats.avg_turn_count?.toFixed(1) ?? '—'} turns`}
          sparkValues={sessionSeries}
          sparkColor="hsl(270 60% 55%)"
        />
        <KpiTile
          label="Total LLM cost"
          value={formatCost(stats.total_estimated_cost_usd)}
          sub={`priced on token usage · ${range}`}
          sparkValues={costSeries}
          sparkColor="hsl(35 90% 45%)"
        />
        <KpiTile
          label="p95 perceived latency"
          value={formatMs(stats.p95_user_perceived_ms)}
          sub={`p50 ${formatMs(stats.p50_user_perceived_ms)} · p99 ${formatMs(
            stats.p99_user_perceived_ms,
          )}`}
          sparkValues={p95Series}
          sparkColor={p95Bad ? 'hsl(0 70% 50%)' : 'hsl(210 90% 42%)'}
        />
        <KpiTile
          label="LiveKit judge pass rate"
          value={formatPct(stats.llm_pass_rate)}
          sub="conversation-level judges"
          barPct={llmRatePct ?? undefined}
          barVariant={passRateBarVariant(llmRatePct)}
        />
        <KpiTile
          label="Simulation pass rate"
          value={formatPct(stats.ci_pass_rate)}
          sub="scenarios run against the agent"
          barPct={ciRatePct ?? undefined}
          barVariant={passRateBarVariant(ciRatePct)}
        />
      </div>

      {!hasData ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          No sessions for <code>{agentId}</code> in the selected range.
        </div>
      ) : (
        <>
          {/* Sessions over time + latency over time, side-by-side */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-medium">
                  Sessions over time
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={stats.buckets}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="bucket_start"
                      tickFormatter={xTickFormatter}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                    />
                    <YAxis
                      allowDecimals={false}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                    />
                    <Tooltip
                      labelFormatter={(iso) => new Date(iso as string).toLocaleString()}
                      contentStyle={{
                        background: 'hsl(var(--background))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="session_count" fill={COLORS.accent} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-medium">
                  p95 perceived latency (ms)
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={stats.buckets}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="bucket_start"
                      tickFormatter={xTickFormatter}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                    />
                    <YAxis
                      tickFormatter={(v) => `${v}`}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                    />
                    <Tooltip
                      labelFormatter={(iso) => new Date(iso as string).toLocaleString()}
                      formatter={(v) => [`${v} ms`, 'p95']}
                      contentStyle={{
                        background: 'hsl(var(--background))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="p95_user_perceived_ms"
                      stroke={COLORS.bad}
                      dot={false}
                      strokeWidth={2}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          {/* Avg session duration over time + provider breakdown */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-medium">
                  Avg session duration (ms)
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={stats.buckets}>
                    <defs>
                      <linearGradient id="durFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={COLORS.accent} stopOpacity={0.4} />
                        <stop offset="100%" stopColor={COLORS.accent} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="bucket_start"
                      tickFormatter={xTickFormatter}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                    />
                    <YAxis
                      tickFormatter={(v) => formatDuration(Number(v))}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                    />
                    <Tooltip
                      labelFormatter={(iso) => new Date(iso as string).toLocaleString()}
                      formatter={(v) => [formatDuration(Number(v)), 'avg duration']}
                      contentStyle={{
                        background: 'hsl(var(--background))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="avg_duration_ms"
                      stroke={COLORS.accent}
                      fill="url(#durFill)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-medium">
                  LLM provider mix
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                {stats.provider_breakdown.length === 0 ? (
                  <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
                    No provider metadata in the last {range}
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie
                        data={stats.provider_breakdown}
                        dataKey="count"
                        nameKey={(d: any) =>
                          d.model ? `${d.provider} · ${d.model}` : d.provider
                        }
                        innerRadius={50}
                        outerRadius={85}
                        paddingAngle={2}
                      >
                        {stats.provider_breakdown.map((_, i) => (
                          <Cell key={i} fill={COLORS.pie[i % COLORS.pie.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          background: 'hsl(var(--background))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                        formatter={(v, name) => [`${v} turns`, name]}
                      />
                      <Legend
                        verticalAlign="bottom"
                        wrapperStyle={{ fontSize: 11 }}
                        formatter={(value) => <span className="text-muted-foreground">{value}</span>}
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
