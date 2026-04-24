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

// Monochrome donut — prompt = full ink, completion = 40% ink. Relative
// weight drives the visual signal instead of hue.
const COLORS = [
  'hsl(var(--foreground))',
  'hsl(var(--foreground) / 0.4)',
]

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
    <div className="rounded-lg border bg-card p-5">
      <span className="text-p-400 font-medium">Token Usage</span>

      <div className="mt-3 flex items-start gap-6">
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
                  innerRadius={30}
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

        <div className="flex-1 space-y-2 text-s-400">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Total Tokens</span>
            <span className="font-medium">{data.total.toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Prompt</span>
            <span>{data.prompt.toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Completion</span>
            <span>{data.completion.toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Tokens/Turn</span>
            <span>{data.tokensPerTurn}</span>
          </div>
          {data.ttsChars > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">TTS Characters</span>
              <span>{data.ttsChars.toLocaleString()}</span>
            </div>
          )}
        </div>
      </div>

      {chartData.length > 0 && (
        <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-foreground" />
            Prompt
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-foreground/40" />
            Completion
          </span>
        </div>
      )}
    </div>
  )
}
