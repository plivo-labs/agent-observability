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

  const chartData = useMemo<ChartEntry[]>(() => {
    if (!metrics?.turns?.length) return []
    return metrics.turns
      .filter((t) => t.user_perceived_ms != null || t.llm_ttft_ms != null || t.tts_ttfb_ms != null)
      .map((t) => ({
        turn: t.turn_number,
        perceived: t.user_perceived_ms,
        llm: t.llm_ttft_ms,
        tts: t.tts_ttfb_ms,
      }))
  }, [metrics])

  if (!chartData.length) return null

  return (
    <ChartCard
      title="Latency Over Turns"
      subtitle="How latency changes throughout the conversation"
      legend={[
        { color: 'hsl(var(--primary))', label: 'User Perceived' },
        { color: 'hsl(var(--accent-purple))', label: 'LLM TTFT' },
        { color: 'hsl(var(--success))', label: 'TTS TTFB' },
      ]}
    >
      <LineChart data={chartData}>
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
        <Line type="monotone" dataKey="perceived" name="User Perceived" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} connectNulls />
        <Line type="monotone" dataKey="llm" name="LLM TTFT" stroke="hsl(var(--accent-purple))" dot={false} strokeWidth={2} connectNulls />
        <Line type="monotone" dataKey="tts" name="TTS TTFB" stroke="hsl(var(--success))" dot={false} strokeWidth={2} connectNulls />
      </LineChart>
    </ChartCard>
  )
}
