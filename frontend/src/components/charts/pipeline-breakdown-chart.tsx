import { useMemo } from 'react'
import { Bar, BarChart, Legend, Tooltip, XAxis, YAxis } from 'recharts'
import { computeAvg, formatMs } from '@/lib/format'
import type { SessionMetrics } from '@/lib/types'
import { ChartCard } from './chart-shared'

const COLORS = {
  stt: 'hsl(210 80% 55%)',
  llm: 'hsl(270 60% 55%)',
  tts: 'hsl(150 60% 45%)',
  unaccounted: 'hsl(230 7% 78%)',
}

interface BreakdownRow {
  label: string
  stt: number
  llm: number
  tts: number
  unaccounted: number
  total: number
}

const PipelineTooltip = ({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload: BreakdownRow }>
}) => {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="rounded-lg border bg-background p-3 text-s-400 shadow-md">
      <p className="font-medium mb-1">{d.label}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        <span style={{ color: COLORS.stt }}>STT</span>
        <span>{formatMs(d.stt)}</span>
        <span style={{ color: COLORS.llm }}>LLM</span>
        <span>{formatMs(d.llm)}</span>
        <span style={{ color: COLORS.tts }}>TTS</span>
        <span>{formatMs(d.tts)}</span>
        <span className="text-muted-foreground">Other</span>
        <span>{formatMs(d.unaccounted)}</span>
        <span className="font-medium">Total</span>
        <span className="font-medium">{formatMs(d.total)}</span>
      </div>
    </div>
  )
}

export const PipelineBreakdownChart = ({ metrics }: { metrics: SessionMetrics | null }) => {
  const chartData = useMemo(() => {
    if (!metrics?.turns?.length) return []

    const sttValues = metrics.turns.map((t) => t.stt_delay_ms).filter((v): v is number => v != null)
    const llmValues = metrics.turns.map((t) => t.llm_ttft_ms).filter((v): v is number => v != null)
    const ttsValues = metrics.turns.map((t) => t.tts_ttfb_ms).filter((v): v is number => v != null)
    const totalValues = metrics.turns
      .map((t) => t.user_perceived_ms)
      .filter((v): v is number => v != null)

    if (!totalValues.length) return []

    const total = computeAvg(totalValues)
    const stt = computeAvg(sttValues)
    const llm = computeAvg(llmValues)
    const tts = computeAvg(ttsValues)
    const unaccounted = Math.max(0, total - stt - llm - tts)

    return [{ label: 'Avg', stt, llm, tts, unaccounted, total }]
  }, [metrics])

  if (!chartData.length) return null

  return (
    <ChartCard
      title="Pipeline Breakdown"
      subtitle="Where is time spent in the pipeline?"
      legend={[]}
      chartHeight="h-48"
    >
      <BarChart data={chartData} layout="vertical" barCategoryGap="30%">
        <XAxis
          type="number"
          tickFormatter={(v: number) => formatMs(v)}
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
          stroke="hsl(var(--st2))"
        />
        <YAxis
          type="category"
          dataKey="label"
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
          stroke="hsl(var(--st2))"
          width={40}
        />
        <Tooltip content={<PipelineTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} />
        <Legend formatter={(value: string) => <span className="text-xs">{value}</span>} />
        <Bar dataKey="stt" name="STT" stackId="stack" fill={COLORS.stt} radius={[0, 0, 0, 0]} />
        <Bar dataKey="llm" name="LLM" stackId="stack" fill={COLORS.llm} />
        <Bar dataKey="tts" name="TTS" stackId="stack" fill={COLORS.tts} />
        <Bar
          dataKey="unaccounted"
          name="Other"
          stackId="stack"
          fill={COLORS.unaccounted}
          radius={[0, 4, 4, 0]}
        />
      </BarChart>
    </ChartCard>
  )
}
