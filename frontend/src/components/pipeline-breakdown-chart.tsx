import { useMemo } from 'react'
import { Bar, BarChart, Legend, Tooltip, XAxis, YAxis } from 'recharts'
import { computeAvg, formatMs } from '@/lib/observability-format'
import type { SessionMetrics } from '@/lib/observability-types'
import { usePerformance } from '@/lib/observability-hooks'
import { ChartCard } from '@/components/observability-chart-shared'

const COLORS = {
  eou: 'var(--chart-5)',
  stt: 'var(--chart-2)',
  llm: 'var(--chart-3)',
  tts: 'var(--chart-4)',
  unaccounted: 'var(--chart-1)',
}

interface BreakdownRow {
  label: string
  /** Rendered EOU segment — raw EOU minus the STT overlap (see eouRaw). */
  eou: number
  /** Raw avg end-of-turn delay, shown in the tooltip. */
  eouRaw: number
  stt: number
  llm: number
  tts: number
  unaccounted: number
  total: number
}

const PipelineTooltip = ({
  active,
  payload,
  hasEou,
  hasStt,
  hasTts,
  hasOther,
}: {
  active?: boolean
  payload?: Array<{ payload: BreakdownRow }>
  hasEou: boolean
  hasStt: boolean
  hasTts: boolean
  hasOther: boolean
}) => {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="rounded-none border border-foreground bg-card p-3 text-[12px] font-mono shadow-none">
      <p className="font-medium mb-1">{d.label}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        {hasEou && (
          <>
            <span style={{ color: COLORS.eou }}>EOU (turn detection)</span>
            <span>{formatMs(d.eouRaw)}</span>
          </>
        )}
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
      return { data: [], hasEou: false, hasStt: false, hasLlm: false, hasTts: false, hasOther: false }
    }

    const eouValues = metrics.turns.map((t) => t.turn_decision_ms).filter((v): v is number => v != null)
    const sttValues = metrics.turns.map((t) => t.stt_delay_ms).filter((v): v is number => v != null)
    const llmValues = metrics.turns.map((t) => t.llm_ttft_ms).filter((v): v is number => v != null)
    const ttsValues = metrics.turns.map((t) => t.tts_ttfb_ms).filter((v): v is number => v != null)
    const totalValues = metrics.turns
      .map((t) => t.user_perceived_ms)
      .filter((v): v is number => v != null)

    const hasEou = eouValues.length > 0
    const hasStt = sttValues.length > 0
    const hasLlm = llmValues.length > 0
    const hasTts = ttsValues.length > 0

    if (!totalValues.length || !hasLlm || (!hasStt && !hasTts)) {
      return { data: [], hasEou, hasStt, hasLlm, hasTts, hasOther: false }
    }

    const total = computeAvg(totalValues)
    const stt = hasStt ? computeAvg(sttValues) : 0
    const llm = computeAvg(llmValues)
    const tts = hasTts ? computeAvg(ttsValues) : 0
    // LiveKit's end_of_turn_delay clock starts at end-of-user-speech, so it
    // CONTAINS transcription_delay — render only the non-STT remainder as a
    // segment (the tooltip still shows the raw EOU value via eouRaw).
    const eouRaw = hasEou ? computeAvg(eouValues) : 0
    const eou = hasEou ? Math.max(0, eouRaw - stt) : 0
    const unaccounted = Math.max(0, total - eou - stt - llm - tts)
    const hasOther = unaccounted > 0

    return {
      data: [{ label: 'Avg', eou, eouRaw, stt, llm, tts, unaccounted, total }],
      hasEou,
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
          tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
          stroke="var(--st2)"
        />
        <YAxis
          type="category"
          dataKey="label"
          tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
          stroke="var(--st2)"
          width={40}
        />
        <Tooltip
          content={
            <PipelineTooltip
              hasEou={chart.hasEou}
              hasStt={chart.hasStt}
              hasTts={chart.hasTts}
              hasOther={chart.hasOther}
            />
          }
          cursor={{ fill: 'color-mix(in oklab, var(--muted) 40%, transparent)' }}
        />
        <Legend formatter={(value: string) => <span className="text-xs">{value}</span>} />
        {chart.hasEou && <Bar dataKey="eou" name="EOU" stackId="stack" fill={COLORS.eou} />}
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
