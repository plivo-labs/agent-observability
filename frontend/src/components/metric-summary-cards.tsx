import { Coins, Gauge, MessageCircle, OctagonX, Split, Timer, Wrench } from 'lucide-react'
import { formatMs } from '@/lib/observability-format'
import type { SessionMetrics } from '@/lib/observability-types'
import { usePerformance } from '@/lib/observability-hooks'

type Tone = 'good' | 'warn' | 'bad'

type Tile = {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  /** Raw value used to decide whether the tile carries real data. A tile whose
   *  display value is empty / a dash / null / undefined is dropped entirely so
   *  the row never shows an empty cell. */
  hasValue: boolean
  sub?: string
  tone?: Tone
  feature?: boolean
}

function MetricTile({ icon, label, value, sub, tone, feature }: Omit<Tile, 'hasValue'>) {
  const toneClass = tone === 'good' ? ' is-good' : tone === 'warn' ? ' is-warn' : tone === 'bad' ? ' is-bad' : ''
  return (
    <div className={`ao-stat${feature ? ' ao-stat--feature is-accent' : ''}${toneClass}`}>
      <div className="ao-stat-label">
        {icon} {label}
      </div>
      <div className="ao-stat-value">{value}</div>
      {sub && <div className="ao-stat-meta">{sub}</div>}
    </div>
  )
}

/** User-perceived speech latency thresholds. Good < 1s, warn 1–2s, bad > 2s. */
function latencyTone(ms: number | null): Tone | undefined {
  if (ms == null) return undefined
  if (ms < 1000) return 'good'
  if (ms < 2000) return 'warn'
  return 'bad'
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
  // Turn-detection (end-of-turn decision) latency + barge-in rate. Present for
  // real-call / LiveKit sessions; '—' (and no rate) for text sims.
  const turnDecisionMs = summary.p95_turn_decision_ms ?? summary.avg_turn_decision_ms ?? null
  const interruptionRate = summary.interruption_rate

  const renderLatency = (ms: number | null) => {
    if (ms == null) return '—'
    const { num, unit } = splitValue(formatMs(ms))
    return (
      <>
        {num}
        {unit && <span className="unit">{unit}</span>}
      </>
    )
  }

  // Build every candidate tile, then drop the ones with no real value so the
  // row never renders an empty cell (e.g. text sims have no audio latency;
  // calls without token accounting have no Total Tokens). Numeric counters
  // (turns / tool calls) are always shown — 0 is a meaningful value there.
  const tiles: Tile[] = [
    {
      icon: <Gauge size={12} />,
      label: 'P95 Latency',
      value: renderLatency(p95),
      hasValue: p95 != null,
      sub: p95 != null ? 'user perceived' : undefined,
      tone: latencyTone(p95),
      feature: true,
    },
    {
      icon: <MessageCircle size={12} />,
      label: 'Turns',
      value: summary.total_turns,
      hasValue: true,
    },
    {
      icon: <OctagonX size={12} />,
      label: 'Barge-in',
      value: interruptions,
      hasValue: true,
      sub: interruptionRate != null ? `${Math.round(interruptionRate * 100)}% of turns` : undefined,
    },
    {
      icon: <Split size={12} />,
      label: 'Turn Detection',
      value: renderLatency(turnDecisionMs),
      hasValue: turnDecisionMs != null,
      sub: turnDecisionMs != null ? 'end-of-turn decision' : undefined,
      tone: latencyTone(turnDecisionMs),
    },
    {
      icon: <Wrench size={12} />,
      label: 'Tool Calls',
      value: summary.total_tool_calls,
      hasValue: true,
    },
    {
      icon: <Timer size={12} />,
      label: 'Avg Latency',
      value: renderLatency(avg),
      hasValue: avg != null,
      sub: avg != null ? 'user perceived' : undefined,
      tone: latencyTone(avg),
    },
    {
      icon: <Coins size={12} />,
      label: 'Total Tokens',
      value: totalTokens > 0 ? totalTokens.toLocaleString() : '—',
      hasValue: totalTokens > 0,
      sub:
        totalTokens > 0 && summary.total_turns > 0
          ? `~${Math.round(totalTokens / summary.total_turns).toLocaleString()}/turn`
          : undefined,
    },
  ]

  const visibleTiles = tiles.filter((t) => t.hasValue)
  if (visibleTiles.length === 0) return null

  // Lay the surviving tiles out as one clean row. `.ao-stat-row` is an
  // auto-fit grid (`minmax(168px, 1fr)`) that fits all the (now-trimmed) tiles
  // on a single row at normal detail-page widths and wraps gracefully when the
  // viewport is narrow — no empty cells, no fixed column count to overflow.
  return (
    <div className="ao-stat-row ao-stagger">
      {visibleTiles.map((t) => (
        <MetricTile
          key={t.label}
          icon={t.icon}
          label={t.label}
          value={t.value}
          sub={t.sub}
          tone={t.tone}
          feature={t.feature}
        />
      ))}
    </div>
  )
}
