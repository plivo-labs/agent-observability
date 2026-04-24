import { Clock, Coins, Gauge, MessageCircle, Wrench, Zap } from 'lucide-react'
import { formatMs } from '@/lib/observability-format'
import type { SessionMetrics } from '@/lib/observability-types'
import { usePerformance } from '@/lib/observability-hooks'

// Monochrome: emphasis comes from weight, not hue. The P95 tile reads as
// foreground ink at all times; warn states surface via border on the tile
// rather than the number turning red.
const p95Color = (_ms: number) => 'text-foreground'

const StatCard = ({
  icon: Icon,
  label,
  value,
  sub,
  valueColor,
}: {
  icon: React.ElementType
  label: string
  value: string
  sub?: string
  valueColor?: string
}) => {
  return (
    <div className="group rounded-lg border bg-card p-4 transition-colors hover:border-primary/20">
      <div className="flex items-center gap-2 mb-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-muted">
          <Icon size={13} className="text-primary" />
        </div>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <span className={`text-h1-400 font-semibold tracking-tight ${valueColor || ''}`}>{value}</span>
      {sub && <p className="text-[10px] text-muted-foreground mt-1">{sub}</p>}
    </div>
  )
}

export const MetricSummaryCards = ({ metrics: metricsProp }: { metrics?: SessionMetrics | null }) => {
  const { metrics: hookMetrics } = usePerformance()
  const metrics = metricsProp ?? hookMetrics

  if (!metrics) return null

  const { summary } = metrics
  const p95 = summary.p95_user_perceived_ms ?? summary.latency?.user_perceived_ms?.p95 ?? null
  const avgLatency = summary.avg_user_perceived_ms ?? summary.latency?.user_perceived_ms?.avg ?? null
  const totalTokens = summary.total_llm_tokens ?? summary.usage?.total_llm_tokens ?? 0
  const interruptions = summary.interruptions ?? summary.interruption?.total_interruptions ?? 0

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
      <StatCard
        icon={MessageCircle}
        label="Turns"
        value={String(summary.total_turns)}
      />
      <StatCard
        icon={Zap}
        label="Interruptions"
        value={String(interruptions)}
      />
      <StatCard
        icon={Wrench}
        label="Tool Calls"
        value={String(summary.total_tool_calls)}
      />
      <StatCard
        icon={Gauge}
        label="P95 Latency"
        value={p95 != null ? formatMs(p95) : '—'}
        valueColor={p95 != null ? p95Color(p95) : undefined}
        sub={p95 != null ? 'user perceived' : undefined}
      />
      <StatCard
        icon={Clock}
        label="Avg Latency"
        value={avgLatency != null ? formatMs(avgLatency) : '—'}
        sub={avgLatency != null ? 'user perceived' : undefined}
      />
      <StatCard
        icon={Coins}
        label="Total Tokens"
        value={totalTokens > 0 ? totalTokens.toLocaleString() : '—'}
        sub={
          totalTokens > 0 && summary.total_turns > 0
            ? `~${Math.round(totalTokens / summary.total_turns).toLocaleString()}/turn`
            : undefined
        }
      />
    </div>
  )
}
