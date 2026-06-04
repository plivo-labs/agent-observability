import { formatCost, formatMs, formatTokens } from '@/lib/observability-format'
import type { EvalRunDetail } from '@/lib/observability-types'
import { KpiTile } from '@/components/kpi'
import {
  TTFB_BAD_MS,
  TTFT_BAD_MS,
  asrTone,
  fmtMsParts,
  latencyTone,
  passRateTone,
  type MetricsView,
  type RunStats,
} from './model'

export function KpiStrip({
  run,
  stats,
  view,
}: {
  run: EvalRunDetail
  stats: RunStats
  view: MetricsView
}) {
  const ttftParts = fmtMsParts(run.ttft_p95_ms)
  const ttfbParts = fmtMsParts(run.ttfb_p95_ms)

  return (
    <div
      className="grid gap-2.5"
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}
    >
      <KpiTile
        label="Pass rate"
        value={stats.passRate.toFixed(0)}
        unit="%"
        valueTone={passRateTone(stats.passRate)}
        hint={`${run.passed}✓ ${run.failed > 0 ? ` · ${run.failed}✗` : ''}`}
      />
      <KpiTile
        label="Cases"
        value={run.total}
        hint={`${run.passed}✓${run.failed ? ` · ${run.failed}✗` : ''}${run.errored ? ` · ${run.errored}!` : ''}`}
      />
      <KpiTile
        label="p95 TTFT"
        value={ttftParts.value}
        unit={ttftParts.unit ?? undefined}
        valueTone={latencyTone(run.ttft_p95_ms, TTFT_BAD_MS)}
        hint={run.ttft_avg_ms != null ? `avg ${formatMs(run.ttft_avg_ms)}` : undefined}
      />
      {view === 'voice' && (
        <KpiTile
          label="p95 TTFB"
          value={ttfbParts.value}
          unit={ttfbParts.unit ?? undefined}
          valueTone={latencyTone(run.ttfb_p95_ms, TTFB_BAD_MS)}
          hint={run.ttfb_avg_ms != null ? `avg ${formatMs(run.ttfb_avg_ms)}` : undefined}
        />
      )}
      <KpiTile
        label="Tokens"
        value={formatTokens(run.total_tokens)}
        hint={
          run.total_tokens > 0
            ? `${stats.avgTokensPerCase.toLocaleString()} avg/case`
            : undefined
        }
        valueTone={run.total_tokens === 0 ? 'mute' : 'default'}
      />
      <KpiTile
        label="LLM cost"
        value={formatCost(run.estimated_cost_usd)}
        hint={
          stats.avgCostPerCase != null
            ? `$${stats.avgCostPerCase.toFixed(4)}/case`
            : undefined
        }
        valueTone={run.estimated_cost_usd == null ? 'mute' : 'default'}
      />
      <KpiTile
        label="Tool calls"
        value={stats.totalToolCalls > 0 ? stats.totalToolCalls : '—'}
        hint={
          stats.totalToolCalls > 0
            ? `${stats.avgToolCallsPerCase.toFixed(1)} avg/case`
            : undefined
        }
        valueTone={stats.totalToolCalls === 0 ? 'mute' : 'default'}
      />
      {run.prompt_tokens > 0 && (
        <KpiTile
          label="Cache %"
          value={((run.cached_prompt_tokens / run.prompt_tokens) * 100).toFixed(1)}
          unit="%"
          hint={`${formatTokens(run.cached_prompt_tokens)} / ${formatTokens(run.prompt_tokens)}`}
        />
      )}
      {stats.avgAsr != null && (
        <KpiTile
          label="ASR conf."
          value={(stats.avgAsr * 100).toFixed(1)}
          unit="%"
          valueTone={asrTone(stats.avgAsr)}
          hint={
            stats.totalInterrupts > 0
              ? `${stats.totalInterrupts} interrupt${stats.totalInterrupts === 1 ? '' : 's'}`
              : undefined
          }
          hintTone={stats.totalInterrupts > 0 ? 'warn' : 'mute'}
        />
      )}
    </div>
  )
}
