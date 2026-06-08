import { useMemo } from 'react'
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts'
import { formatMs } from '@/lib/observability-format'
import type { SessionMetrics } from '@/lib/observability-types'
import { usePerformance } from '@/lib/observability-hooks'
import { ChartCard, ChartTooltipShell } from '@/components/observability-chart-shared'

interface ChartEntry {
  turn: number
  perceived?: number
  llm?: number
  tts?: number
}

const LatencyTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: Array<{ name: string; value: number; color: string }>
  label?: number
}) => {
  return (
    <ChartTooltipShell
      active={active}
      label={label}
      rows={
        payload?.length
          ? payload.map((p) => ({ label: p.name, value: formatMs(p.value), color: p.color }))
          : []
      }
    />
  )
}

export const LatencyOverTurnsChart = ({ metrics: metricsProp }: { metrics?: SessionMetrics | null }) => {
  const { metrics: hookMetrics } = usePerformance()
  const metrics = metricsProp ?? hookMetrics

  const chart = useMemo(() => {
    if (!metrics?.turns?.length) {
      return { data: [] as ChartEntry[], hasPerceived: false, hasLlm: false, hasTts: false }
    }

    const hasPerceived = metrics.turns.some((t) => t.user_perceived_ms != null)
    const hasLlm = metrics.turns.some((t) => t.llm_ttft_ms != null)
    const hasTts = metrics.turns.some((t) => t.tts_ttfb_ms != null)
    const data = metrics.turns
      .filter((t) =>
        (hasPerceived && t.user_perceived_ms != null) ||
        (hasLlm && t.llm_ttft_ms != null) ||
        (hasTts && t.tts_ttfb_ms != null)
      )
      .map((t): ChartEntry => ({
        turn: t.turn_number,
        ...(hasPerceived ? { perceived: t.user_perceived_ms } : {}),
        ...(hasLlm ? { llm: t.llm_ttft_ms } : {}),
        ...(hasTts ? { tts: t.tts_ttfb_ms } : {}),
      }))

    return { data, hasPerceived, hasLlm, hasTts }
  }, [metrics])

  if (!chart.data.length) return null

  const legend = [
    chart.hasPerceived && { color: 'hsl(var(--primary))', label: 'User Perceived' },
    chart.hasLlm && { color: 'hsl(var(--accent-purple))', label: 'LLM TTFT' },
    chart.hasTts && { color: 'hsl(var(--success))', label: 'TTS TTFB' },
  ].filter(Boolean) as Array<{ color: string; label: string }>

  return (
    <ChartCard
      title="Latency Over Turns"
      subtitle="How latency changes throughout the conversation"
      legend={legend}
    >
      <LineChart data={chart.data}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--st1))" />
        <XAxis
          dataKey="turn"
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
          stroke="hsl(var(--st2))"
        />
        <YAxis
          tickFormatter={(v: number) => formatMs(v)}
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
          stroke="hsl(var(--st2))"
        />
        <Tooltip content={<LatencyTooltip />} />
        {chart.hasPerceived && <Line type="monotone" dataKey="perceived" name="User Perceived" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} connectNulls />}
        {chart.hasLlm && <Line type="monotone" dataKey="llm" name="LLM TTFT" stroke="hsl(var(--accent-purple))" dot={false} strokeWidth={2} connectNulls />}
        {chart.hasTts && <Line type="monotone" dataKey="tts" name="TTS TTFB" stroke="hsl(var(--success))" dot={false} strokeWidth={2} connectNulls />}
      </LineChart>
    </ChartCard>
  )
}
