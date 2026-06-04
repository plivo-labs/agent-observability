import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatCost, formatDuration, formatMs, formatTokens } from '@/lib/observability-format'
import type { EvalRunDetail } from '@/lib/observability-types'
import { Panel } from './primitives'
import {
  COLOR_TTFB,
  COLOR_TTFT,
  type MetricsView,
  type OverCasesDatum,
} from './model'

// Shared chart chrome — recharts looks at JSX children directly so the
// `<CartesianGrid + axes + Tooltip>` block has to live inside each chart;
// the styling tokens are pulled out so they can't drift.
const CHART_TOOLTIP_STYLE = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 6,
  fontSize: 11,
} as const

const AXIS_TICK = { fill: 'hsl(var(--muted-foreground))', fontSize: 10 } as const

// ── Latency over cases (line) ──────────────────────────────────────────────

export function LatencyOverCasesChart({
  data,
  view,
}: {
  data: OverCasesDatum[]
  view: MetricsView
}) {
  return (
    <Panel
      title="Latency over cases (ms)"
      legend={[
        { color: COLOR_TTFT, label: 'TTFT' },
        ...(view === 'voice' ? [{ color: COLOR_TTFB, label: 'TTFB' }] : []),
      ]}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="idx" tick={AXIS_TICK} stroke="hsl(var(--border))" tickLine={false} />
          <YAxis
            tickFormatter={(v: number) => formatMs(v)}
            tick={AXIS_TICK}
            stroke="hsl(var(--border))"
            tickLine={false}
            width={42}
          />
          <Tooltip
            formatter={(v: unknown) => formatMs(Number(v))}
            contentStyle={CHART_TOOLTIP_STYLE}
          />
          <Line
            type="monotone"
            dataKey="ttft"
            name="TTFT"
            stroke={COLOR_TTFT}
            strokeWidth={1.75}
            dot={{ r: 2.5, strokeWidth: 0, fill: COLOR_TTFT }}
            activeDot={{ r: 4 }}
            connectNulls
          />
          {view === 'voice' && (
            <Line
              type="monotone"
              dataKey="ttfb"
              name="TTFB"
              stroke={COLOR_TTFB}
              strokeWidth={1.75}
              dot={false}
              connectNulls
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </Panel>
  )
}

// ── Pipeline breakdown / duration per case (bars) ──────────────────────────

// Voice runs get a stacked TTFT+TTFB bar; text runs get a single duration
// bar. One panel, one set of axes — the `isVoice` switch picks the bars
// and the Y-axis formatter.
export function PipelineOrDurationChart({
  data,
  view,
}: {
  data: OverCasesDatum[]
  view: MetricsView
}) {
  const isVoice = view === 'voice'
  const yFormatter = isVoice ? formatMs : formatDuration
  return (
    <Panel
      title={isVoice ? 'Pipeline breakdown (ms)' : 'Duration per case (ms)'}
      legend={
        isVoice
          ? [
              { color: COLOR_TTFT, label: 'TTFT' },
              { color: COLOR_TTFB, label: 'TTFB' },
            ]
          : [{ color: COLOR_TTFT, label: 'duration' }]
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, left: 0, bottom: 4 }}
          barCategoryGap={3}
        >
          <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="idx" tick={AXIS_TICK} stroke="hsl(var(--border))" tickLine={false} />
          <YAxis
            tickFormatter={(v: number) => yFormatter(v)}
            tick={AXIS_TICK}
            stroke="hsl(var(--border))"
            tickLine={false}
            width={isVoice ? 42 : 48}
          />
          <Tooltip
            formatter={(v: unknown) => yFormatter(Number(v))}
            contentStyle={CHART_TOOLTIP_STYLE}
          />
          {isVoice ? (
            <>
              <Bar dataKey="ttft" stackId="lat" fill={COLOR_TTFT} radius={[0, 0, 0, 0]} />
              <Bar dataKey="ttfb" stackId="lat" fill={COLOR_TTFB} radius={[2, 2, 0, 0]} />
            </>
          ) : (
            <Bar dataKey="duration" fill={COLOR_TTFT} radius={[2, 2, 0, 0]} />
          )}
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  )
}

// ── Token & cost (donut) ───────────────────────────────────────────────────

export function TokenCostPanel({ run }: { run: EvalRunDetail }) {
  return (
    <div className="rounded-lg border bg-card p-4 flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[13px] font-medium">Token &amp; cost</span>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ background: COLOR_TTFT }}
            />
            prompt
          </span>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground/70">
            <span className="inline-block h-2 w-2 rounded-sm border border-current" />
            compl.
          </span>
        </div>
      </div>
      <div className="flex-1 flex items-center gap-5 min-h-[180px]">
        <div className="relative h-[140px] w-[140px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={[
                  { name: 'prompt', value: run.prompt_tokens },
                  { name: 'completion', value: run.completion_tokens },
                ].filter((d) => d.value > 0)}
                dataKey="value"
                cx="50%"
                cy="50%"
                innerRadius={42}
                outerRadius={62}
                strokeWidth={0}
                startAngle={90}
                endAngle={-270}
              >
                <Cell fill={COLOR_TTFT} />
                <Cell fill="hsl(var(--muted))" />
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-[18px] font-semibold tabular-nums leading-none">
              {formatTokens(run.total_tokens)}
            </span>
            <span className="text-[10px] text-muted-foreground mt-0.5">tokens</span>
          </div>
        </div>
        <div className="flex-1 space-y-1.5 text-[12px]">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <span
                className="inline-block h-2 w-2 rounded-sm"
                style={{ background: COLOR_TTFT }}
              />
              prompt
            </span>
            <span className="font-medium tabular-nums">
              {formatTokens(run.prompt_tokens)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <span className="inline-block h-2 w-2 rounded-sm border border-current" />
              completion
            </span>
            <span className="tabular-nums">{formatTokens(run.completion_tokens)}</span>
          </div>
          {run.estimated_cost_usd != null && (
            <div className="flex items-center justify-between gap-3 pt-1.5 border-t border-border">
              <span className="text-muted-foreground">est. cost</span>
              <span className="tabular-nums font-medium">
                {formatCost(run.estimated_cost_usd)}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
