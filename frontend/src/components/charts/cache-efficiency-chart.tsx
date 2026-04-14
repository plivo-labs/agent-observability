import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts'
import type { SessionMetrics } from '@/lib/types'
import { ChartCard, ChartTooltipShell } from './chart-shared'

interface ChartEntry {
  turn: number
  ratio?: number
}

const CacheTooltip = ({
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
      rows={payload?.length ? [{ label: 'Cache Hit', value: `${payload[0].value.toFixed(1)}%` }] : []}
    />
  )
}

export const CacheEfficiencyChart = ({ metrics }: { metrics: SessionMetrics | null }) => {
  const chartData = useMemo<ChartEntry[]>(() => {
    if (!metrics?.turns?.length) return []
    return metrics.turns
      .filter((t) => t.llm_cache_hit_ratio != null)
      .map((t) => ({
        turn: t.turn_number,
        ratio: t.llm_cache_hit_ratio! * 100,
      }))
  }, [metrics])

  if (!chartData.length) return null

  return (
    <ChartCard
      title="Cache Efficiency"
      subtitle="Prompt cache hit ratio over turns"
      legend={[{ color: 'hsl(150 60% 45%)', label: 'Cache Hit %' }]}
    >
      <AreaChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--st1))" />
        <XAxis
          dataKey="turn"
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
          stroke="hsl(var(--st2))"
        />
        <YAxis
          domain={[0, 100]}
          tickFormatter={(v: number) => `${v}%`}
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
          stroke="hsl(var(--st2))"
        />
        <Tooltip content={<CacheTooltip />} />
        <Area
          type="monotone"
          dataKey="ratio"
          name="Cache Hit %"
          stroke="hsl(150 60% 45%)"
          fill="hsl(150 60% 45% / 0.15)"
          strokeWidth={2}
          connectNulls
        />
      </AreaChart>
    </ChartCard>
  )
}
