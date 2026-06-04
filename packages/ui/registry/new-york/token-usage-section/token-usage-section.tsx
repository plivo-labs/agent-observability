import { useMemo } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'
import type { SessionMetrics } from '@/lib/observability-types'
import { usePerformance } from '@/lib/observability-hooks'

interface TokenData {
  prompt: number
  completion: number
  total: number
  ttsChars: number
  tokensPerTurn: string
}

const buildTokenData = (metrics: SessionMetrics): TokenData => {
  const { summary } = metrics
  const prompt = summary.total_llm_prompt_tokens ?? summary.usage?.total_llm_prompt_tokens ?? 0
  const completion = summary.total_llm_completion_tokens ?? summary.usage?.total_llm_completion_tokens ?? 0
  const total = summary.total_llm_tokens ?? summary.usage?.total_llm_tokens ?? 0
  const ttsChars = summary.total_tts_characters ?? summary.usage?.total_tts_characters ?? 0
  const tokensPerTurn =
    summary.total_turns > 0 ? Math.round(total / summary.total_turns).toLocaleString() : '—'

  return { prompt, completion, total, ttsChars, tokensPerTurn }
}

const COLORS = ['hsl(var(--success))', 'hsl(var(--accent-purple))']

const StatRow = ({
  label,
  value,
  strong,
}: {
  label: string
  value: string
  strong?: boolean
}) => (
  <div className="flex items-baseline justify-between border-b border-border/60 py-1.5 last:border-b-0">
    <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
    <span className={`tabular-nums ${strong ? 'font-semibold text-foreground' : 'text-foreground'}`}>{value}</span>
  </div>
)

export const TokenUsageSection = ({ metrics: metricsProp }: { metrics?: SessionMetrics | null }) => {
  const { metrics: hookMetrics } = usePerformance()
  const metrics = metricsProp ?? hookMetrics

  const data = useMemo(() => (metrics ? buildTokenData(metrics) : null), [metrics])

  const chartData = useMemo(() => {
    if (!data) return []
    const items = [
      { name: 'Prompt', value: data.prompt },
      { name: 'Completion', value: data.completion },
    ]
    return items.filter((d) => d.value > 0)
  }, [data])

  if (!data || data.total === 0) return null

  return (
    <div className="ao-chart">
      <div className="ao-chart-head">
        <div>
          <div className="ao-chart-title">Token Usage</div>
          <div className="ao-chart-sub">LLM prompt vs. completion split</div>
        </div>
        {chartData.length > 0 && (
          <div className="ao-chart-legend">
            <span className="ao-legend-item">
              <span className="sw" style={{ background: COLORS[0] }} />
              Prompt
            </span>
            <span className="ao-legend-item">
              <span className="sw" style={{ background: COLORS[1] }} />
              Completion
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-6">
        {chartData.length > 0 && (
          <div className="h-32 w-32 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  dataKey="value"
                  cx="50%"
                  cy="50%"
                  outerRadius={55}
                  innerRadius={32}
                  strokeWidth={0}
                >
                  {chartData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i]} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="flex-1 text-s-400">
          <StatRow label="Total Tokens" value={data.total.toLocaleString()} strong />
          <StatRow label="Prompt" value={data.prompt.toLocaleString()} />
          <StatRow label="Completion" value={data.completion.toLocaleString()} />
          <StatRow label="Tokens / Turn" value={data.tokensPerTurn} />
          {data.ttsChars > 0 && (
            <StatRow label="TTS Characters" value={data.ttsChars.toLocaleString()} />
          )}
        </div>
      </div>
    </div>
  )
}
