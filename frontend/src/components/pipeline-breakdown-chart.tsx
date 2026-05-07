import { useMemo } from 'react'
import { Bar, BarChart, Legend, Tooltip, XAxis, YAxis } from 'recharts'
import { computeAvg, formatMs } from '@/lib/observability-format'
import type { SessionMetrics } from '@/lib/observability-types'
import { usePerformance } from '@/lib/observability-hooks'
import { ChartCard } from '@/components/observability-chart-shared'

const COLORS = {
  stt: 'hsl(var(--info))',
  llm: 'hsl(var(--accent-purple))',
  tts: 'hsl(var(--success))',
  unaccounted: 'hsl(var(--tertiary))',
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
  hasStt,
  hasTts,
  hasOther,
}: {
  active?: boolean
  payload?: Array<{ payload: BreakdownRow }>
  hasStt: boolean
  hasTts: boolean
  hasOther: boolean
}) => {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="rounded-lg border bg-background p-3 text-s-400 shadow-md">
      <p className="font-medium mb-1">{d.label}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        {hasStt && (
          <>
            <span style={{ color: COLORS.stt }}>STT</span>
            <span>{formatMs(d.stt)}</span>
          </>
        )}
        <span style={{ color: COLORS.llm }}>LLM</span>
        <span>{formatMs(d.llm)}</span>
        {hasTts && (
          <>
            <span style={{ color: COLORS.tts }}>TTS</span>
            <span>{formatMs(d.tts)}</span>
          </>
        )}
        {hasOther && (
          <>
            <span className="text-muted-foreground">Other</span>
            <span>{formatMs(d.unaccounted)}</span>
          </>
        )}
        <span className="font-medium">Total</span>
        <span className="font-medium">{formatMs(d.total)}</span>
      </div>
    </div>
  )
}

export const PipelineBreakdownChart = ({ metrics: metricsProp }: { metrics?: SessionMetrics | null }) => {
  const { metrics: hookMetrics } = usePerformance()
  const metrics = metricsProp ?? hookMetrics

  const chart = useMemo(() => {
    if (!metrics?.turns?.length) {
      return { data: [], hasStt: false, hasLlm: false, hasTts: false, hasOther: false }
    }

    const sttValues = metrics.turns.map((t) => t.stt_delay_ms).filter((v): v is number => v != null)
    const llmValues = metrics.turns.map((t) => t.llm_ttft_ms).filter((v): v is number => v != null)
    const ttsValues = metrics.turns.map((t) => t.tts_ttfb_ms).filter((v): v is number => v != null)
    const totalValues = metrics.turns
      .map((t) => t.user_perceived_ms)
      .filter((v): v is number => v != null)

    const hasStt = sttValues.length > 0
    const hasLlm = llmValues.length > 0
    const hasTts = ttsValues.length > 0

    if (!totalValues.length || !hasLlm || (!hasStt && !hasTts)) {
      return { data: [], hasStt, hasLlm, hasTts, hasOther: false }
    }

    const total = computeAvg(totalValues)
    const stt = hasStt ? computeAvg(sttValues) : 0
    const llm = computeAvg(llmValues)
    const tts = hasTts ? computeAvg(ttsValues) : 0
    const unaccounted = Math.max(0, total - stt - llm - tts)
    const hasOther = unaccounted > 0

    return {
      data: [{ label: 'Avg', stt, llm, tts, unaccounted, total }],
      hasStt,
      hasLlm,
      hasTts,
      hasOther,
    }
  }, [metrics])

  if (!chart.data.length) return null

  return (
    <ChartCard
      title="Pipeline Breakdown"
      subtitle="Where is time spent in the pipeline?"
      legend={[]}
      chartHeight="h-48"
    >
      <BarChart data={chart.data} layout="vertical" barCategoryGap="30%">
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
        <Tooltip
          content={<PipelineTooltip hasStt={chart.hasStt} hasTts={chart.hasTts} hasOther={chart.hasOther} />}
          cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
        />
        <Legend formatter={(value: string) => <span className="text-xs">{value}</span>} />
        {chart.hasStt && <Bar dataKey="stt" name="STT" stackId="stack" fill={COLORS.stt} radius={[0, 0, 0, 0]} />}
        <Bar dataKey="llm" name="LLM" stackId="stack" fill={COLORS.llm} />
        {chart.hasTts && <Bar dataKey="tts" name="TTS" stackId="stack" fill={COLORS.tts} />}
        {chart.hasOther && (
          <Bar
            dataKey="unaccounted"
            name="Other"
            stackId="stack"
            fill={COLORS.unaccounted}
            radius={[0, 4, 4, 0]}
          />
        )}
      </BarChart>
    </ChartCard>
  )
}
