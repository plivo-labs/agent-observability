import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts'
import { formatMs } from '@/lib/format'
import type { SessionMetrics } from '@/lib/types'
import { ChartCard, ChartTooltipShell } from './chart-shared'

interface ChartEntry {
  turn: number
  user?: number
  agent?: number
}

const TalkTimeTooltip = ({
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
      rows={payload?.length ? payload.map((p) => ({ label: p.name, value: formatMs(p.value) })) : []}
    />
  )
}

export const TalkTimeChart = ({ metrics }: { metrics: SessionMetrics | null }) => {
  const chartData = useMemo<ChartEntry[]>(() => {
    if (!metrics?.turns?.length) return []
    return metrics.turns
      .filter((t) => t.stt_audio_duration_ms != null || t.tts_audio_duration_ms != null)
      .map((t) => ({
        turn: t.turn_number,
        user: t.stt_audio_duration_ms,
        agent: t.tts_audio_duration_ms,
      }))
  }, [metrics])

  if (!chartData.length) return null

  return (
    <ChartCard
      title="Talk Time"
      subtitle="User vs agent speaking duration per turn"
      legend={[
        { color: 'hsl(210 80% 55%)', label: 'User' },
        { color: 'hsl(150 60% 45%)', label: 'Agent' },
      ]}
    >
      <BarChart data={chartData} barCategoryGap="20%">
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
        <Tooltip content={<TalkTimeTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} />
        <Bar dataKey="user" name="User" stackId="a" fill="hsl(210 80% 55%)" radius={[0, 0, 0, 0]} />
        <Bar dataKey="agent" name="Agent" stackId="a" fill="hsl(150 60% 45%)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartCard>
  )
}
