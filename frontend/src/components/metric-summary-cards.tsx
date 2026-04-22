import { Coins, Gauge, MessageCircle, OctagonX, Timer, Wrench } from 'lucide-react'
import { formatMs } from '@/lib/observability-format'
import type { SessionMetrics } from '@/lib/observability-types'
import { usePerformance } from '@/lib/observability-hooks'

function MetricTile({
  icon,
  label,
  value,
  sub,
  warn,
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  sub?: string
  warn?: boolean
}) {
  return (
    <div className={`metric-tile${warn ? ' warn' : ''}`}>
      <div className="hd">
        {icon} {label}
      </div>
      <div className="val">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  )
}

/** Split a formatted ms string like "1.42s" or "382ms" into number + unit so
 * the tile renders the unit as a lighter-weight suffix. */
function splitValue(formatted: string): { num: string; unit: string } {
  const match = formatted.match(/^([\d.]+)\s*(.*)$/)
  if (!match) return { num: formatted, unit: '' }
  return { num: match[1], unit: match[2] }
}

export const MetricSummaryCards = ({
  metrics: metricsProp,
}: {
  metrics?: SessionMetrics | null
}) => {
  const { metrics: hookMetrics } = usePerformance()
  const metrics = metricsProp ?? hookMetrics
  if (!metrics) return null

  const { summary } = metrics
  const p95 = summary.p95_user_perceived_ms ?? summary.latency?.user_perceived_ms?.p95 ?? null
  const avg = summary.avg_user_perceived_ms ?? summary.latency?.user_perceived_ms?.avg ?? null
  const totalTokens = summary.total_llm_tokens ?? summary.usage?.total_llm_tokens ?? 0
  const interruptions = summary.interruptions ?? summary.interruption?.total_interruptions ?? 0

  const renderLatency = (ms: number | null) => {
    if (ms == null) return '—'
    const { num, unit } = splitValue(formatMs(ms))
    return (
      <>
        {num}
        <span style={{ fontSize: '0.6em', fontWeight: 500, marginLeft: 2 }}>{unit}</span>
      </>
    )
  }

  return (
    <div className="obs-metrics">
      <MetricTile icon={<MessageCircle size={12} />} label="Turns" value={summary.total_turns} />
      <MetricTile icon={<OctagonX size={12} />} label="Interruptions" value={interruptions} />
      <MetricTile icon={<Wrench size={12} />} label="Tool Calls" value={summary.total_tool_calls} />
      <MetricTile
        icon={<Gauge size={12} />}
        label="P95 Latency"
        value={renderLatency(p95)}
        sub={p95 != null ? 'user perceived' : undefined}
        warn={p95 != null && p95 >= 2000}
      />
      <MetricTile
        icon={<Timer size={12} />}
        label="Avg Latency"
        value={renderLatency(avg)}
        sub={avg != null ? 'user perceived' : undefined}
      />
      <MetricTile
        icon={<Coins size={12} />}
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
