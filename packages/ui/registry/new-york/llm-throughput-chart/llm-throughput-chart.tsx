import { useMemo } from 'react'
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts'
import type { SessionMetrics } from '@/lib/observability-types'
import { usePerformance } from '@/lib/observability-hooks'
import { ChartCard, ChartTooltipShell } from '@/components/observability-chart-shared'

interface ChartEntry {
  turn: number
  tps?: number
}

const ThroughputTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: Array<{ value: number }>
  label?: number
}) => {
  return (
    <ChartTooltipShell
      active={active}
      label={label}
      rows={
        payload?.length
          ? [{ label: 'Throughput', value: `${payload[0].value.toFixed(1)} tok/s` }]
          : []
      }
    />
  )
}

export const LlmThroughputChart = ({ metrics: metricsProp }: { metrics?: SessionMetrics | null }) => {
  const { metrics: hookMetrics } = usePerformance()
  const metrics = metricsProp ?? hookMetrics

  const chartData = useMemo<ChartEntry[]>(() => {
    if (!metrics?.turns?.length) return []
    return metrics.turns
      .filter((t) => t.llm_tokens_per_second != null)
      .map((t) => ({
        turn: t.turn_number,
        tps: t.llm_tokens_per_second,
      }))
  }, [metrics])

  if (!chartData.length) return null

  return (
    <ChartCard
      title="LLM Throughput"
      subtitle="Token generation speed per turn"
      legend={[{ color: 'hsl(var(--primary))', label: 'Tokens/sec' }]}
    >
      <LineChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--st1))" />
        <XAxis
          dataKey="turn"
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
          stroke="hsl(var(--st2))"
        />
        <YAxis
          tickFormatter={(v: number) => `${v} tok/s`}
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
          stroke="hsl(var(--st2))"
        />
        <Tooltip content={<ThroughputTooltip />} />
        <Line
          type="monotone"
          dataKey="tps"
          name="tok/s"
          stroke="hsl(var(--primary))"
          dot={false}
          strokeWidth={2}
          connectNulls
        />
      </LineChart>
    </ChartCard>
  )
}
