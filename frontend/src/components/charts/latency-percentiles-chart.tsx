import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts'
import { computeAvg, computePercentile, formatMs } from '@/lib/format'
import type { SessionMetrics, TurnRecord } from '@/lib/types'
import { ChartCard } from './chart-shared'

interface ChartEntry {
  name: string
  avg: number
  p95: number
}

const PercentilesTooltip = ({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload: ChartEntry }>
}) => {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="rounded-lg border bg-background p-3 text-s-400 shadow-md">
      <p className="font-medium mb-1">{d.name}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        <span className="text-muted-foreground">Avg</span>
        <span>{formatMs(d.avg)}</span>
        <span className="text-muted-foreground">P95</span>
        <span>{formatMs(d.p95)}</span>
      </div>
    </div>
  )
}

const METRIC_KEYS: { key: keyof TurnRecord; label: string }[] = [
  { key: 'user_perceived_ms', label: 'User Perceived' },
  { key: 'stt_delay_ms', label: 'STT Delay' },
  { key: 'llm_ttft_ms', label: 'LLM TTFT' },
  { key: 'tts_ttfb_ms', label: 'TTS TTFB' },
  { key: 'turn_decision_ms', label: 'Turn Decision' },
]

export const LatencyPercentilesChart = ({ metrics }: { metrics: SessionMetrics | null }) => {
  const chartData = useMemo(() => {
    if (!metrics?.turns?.length) return []

    return METRIC_KEYS.map((m) => {
      const values = metrics.turns
        .map((t) => t[m.key] as number | undefined)
        .filter((v): v is number => v != null)
      if (!values.length) return null
      return {
        name: m.label,
        avg: computeAvg(values),
        p95: computePercentile(values, 0.95),
      }
    }).filter((d): d is ChartEntry => d != null)
  }, [metrics])

  if (!chartData.length) return null

  return (
    <ChartCard
      title="Latency Percentiles"
      legend={[
        { color: 'hsl(var(--primary) / 0.4)', label: 'Avg' },
        { color: 'hsl(var(--primary))', label: 'P95' },
      ]}
    >
      <BarChart data={chartData} barCategoryGap="20%">
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--st1))" />
        <XAxis
          dataKey="name"
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
          stroke="hsl(var(--st2))"
        />
        <YAxis
          tickFormatter={(v: number) => formatMs(v)}
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
          stroke="hsl(var(--st2))"
        />
        <Tooltip content={<PercentilesTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} />
        <Bar dataKey="avg" name="Avg" fill="hsl(var(--primary) / 0.4)" radius={[4, 4, 0, 0]} />
        <Bar dataKey="p95" name="P95" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartCard>
  )
}
