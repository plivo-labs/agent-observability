import { useEffect, useMemo, useState } from 'react'
import { parseAsString, useQueryState } from 'nuqs'
import {
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  Trash2,
} from 'lucide-react'
import { Link } from 'react-router'
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
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  ASR_BAD,
  ASR_WARN,
  TTFB_BAD_MS,
  TTFT_BAD_MS,
  asrTone,
  fmtMsParts,
  formatCost,
  formatDate,
  formatDuration,
  formatMs,
  formatTokens,
  latencyTone,
  passRateTone,
} from '@/lib/observability-format'
import { useEvalRun } from '@/lib/observability-hooks'
import { useObservabilityContext } from '@/lib/observability-provider'
import type {
  CaseStatus,
  EvalCaseRow,
  EvalRunDetail,
  RunEvent,
} from '@/lib/observability-types'
import { KpiTile } from '@/components/kpi'
import { EvalCaseDetailPage } from '@/components/eval-case-detail-page'
import { AgentScopeHeader } from '@/components/agent-scope-header'

// ── Constants ───────────────────────────────────────────────────────────────
// Latency / ASR thresholds + tone helpers (latencyTone / asrTone /
// passRateTone / fmtMsParts) live in observability-format so the same values
// back both these KPIs and the per-session metric summary.

const COLOR_TTFT = 'var(--accent-purple)'
const COLOR_TTFB = 'var(--success-fg)'

// ── Metrics view model ──────────────────────────────────────────────────────

// What kind of latency story this run tells.
//   'voice' — has TTS, so TTFB is meaningful → show TTFB column, pipeline
//             breakdown chart, p95 TTFB KPI, dual-line latency.
//   'text'  — no TTS, so TTFB is always null → hide TTFB sites, show
//             duration-per-case instead of pipeline breakdown.
// Derived once from run + cases. Adding a third modality means changing
// this derivation, not every render site.
type MetricsView = 'voice' | 'text'

function detectMetricsView(run: EvalRunDetail, cases: EvalCaseRow[]): MetricsView {
  const hasTtfb =
    run.ttfb_p95_ms != null ||
    run.ttfb_avg_ms != null ||
    cases.some((c) => c.ttfb_avg_ms != null)
  return hasTtfb ? 'voice' : 'text'
}

// ── ASR confidence (derived per-case) ───────────────────────────────────────

function caseAsrConfidence(events: RunEvent[]): number | null {
  const vals: number[] = []
  for (const ev of events) {
    if (ev.type !== 'message') continue
    const m = ev.metrics
    if (!m) continue
    for (const k of Object.keys(m)) {
      if (
        k === 'user_transcript_confidence' ||
        k === 'stt_confidence' ||
        k === 'asr_confidence'
      ) {
        const v = m[k]
        if (typeof v === 'number' && Number.isFinite(v)) vals.push(v)
      }
    }
  }
  if (vals.length === 0) return null
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length
  return avg > 1 ? avg / 100 : avg
}

// ── Tiny primitives ─────────────────────────────────────────────────────────
// The KPI tile is the shared `KpiTile` (`@/components/kpi`), extended with the
// value-tone / hint props this strip needs.

const STATUS_DOT: Record<CaseStatus, { dot: string; text: string }> = {
  passed: {
    dot: 'bg-success-fg',
    text: 'text-success-fg',
  },
  failed: {
    dot: 'bg-destructive',
    text: 'text-destructive',
  },
  errored: {
    dot: 'bg-warning-fg',
    text: 'text-warning-fg',
  },
  skipped: { dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
}

function StatusDot({ status }: { status: CaseStatus }) {
  const { dot, text } = STATUS_DOT[status]
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[12px]', text)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      {status}
    </span>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard?.writeText(text)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1100)
      }}
      className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition"
      aria-label="Copy run id"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}

function Panel({
  title,
  legend,
  children,
}: {
  title: string
  legend?: { color: string; label: string }[]
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border bg-card p-4 flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <span data-slot="panel-title" className="text-[13px] font-medium">{title}</span>
        {legend && (
          <div className="flex items-center gap-3">
            {legend.map((l) => (
              <span
                key={l.label}
                className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
              >
                <span
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ background: l.color }}
                />
                {l.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="h-[180px] -mx-1">{children}</div>
    </div>
  )
}

type StatusFilter = CaseStatus | 'all'
function FilterPill({
  active,
  onChange,
}: {
  active: StatusFilter
  onChange: (s: StatusFilter) => void
}) {
  const items: StatusFilter[] = ['all', 'passed', 'failed', 'errored']
  return (
    <div className="inline-flex h-8 items-center rounded-md border bg-card p-0.5 text-[12px]">
      {items.map((it) => (
        <button
          key={it}
          type="button"
          onClick={() => onChange(it)}
          className={cn(
            'px-3 h-full rounded-none transition uppercase font-mono text-[11px] tracking-section',
            active === it
              ? 'bg-foreground text-background font-semibold'
              : 'text-tertiary hover:text-foreground',
          )}
        >
          {it}
        </button>
      ))}
    </div>
  )
}

// ── Enriched-case shape (shared by table + stats) ──────────────────────────

type EnrichedCase = EvalCaseRow & {
  asr: number | null
  judgePass: number
  judgeFail: number
  ttftBad: boolean
  ttfbBad: boolean
  asrBad: boolean
  asrWarn: boolean
  hasInterrupt: boolean
}

interface RunStats {
  passRate: number
  totalToolCalls: number
  totalInterrupts: number
  avgToolCallsPerCase: number
  avgTokensPerCase: number
  avgCostPerCase: number | null
  avgAsr: number | null
}

// ── Run meta strip ─────────────────────────────────────────────────────────

function RunMetaStrip({ run }: { run: EvalRunDetail }) {
  const branch = run.ci?.git_branch ? String(run.ci.git_branch) : null
  const sha = run.ci?.git_sha ? String(run.ci.git_sha).slice(0, 7) : null
  const runShort = `${run.run_id.slice(0, 8)}…${run.run_id.slice(-4)}`
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-2 min-w-0">
        {run.framework && (
          <span className="inline-flex shrink-0 items-center gap-1.5 px-2 h-6 rounded-full border bg-card text-[11px] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full border border-current" />
            {run.framework}
            {run.framework_version && (
              <span className="font-mono">{run.framework_version}</span>
            )}
          </span>
        )}
      </div>
      <div className="flex items-center gap-4 text-[12px] text-muted-foreground tabular-nums">
        <span className="inline-flex items-center gap-1 font-mono">
          {runShort}
          <CopyButton text={run.run_id} />
        </span>
        {branch && (
          <span className="inline-flex items-center gap-1 font-mono">
            <GitBranch className="h-3 w-3" />
            {branch}
            {sha && <span className="text-muted-foreground/70">@{sha}</span>}
          </span>
        )}
        <span>
          <span className="text-muted-foreground/70">dur</span>{' '}
          <span className="text-foreground">{formatDuration(run.duration_ms)}</span>
        </span>
        <span className="text-muted-foreground/70">·</span>
        <span>{formatDate(run.started_at)}</span>
        {run.ci?.run_url && (
          <a
            href={String(run.ci.run_url)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-link hover:underline"
          >
            CI <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  )
}

// ── KPI strip ──────────────────────────────────────────────────────────────

function KpiStrip({
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
    <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
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

// ── Charts ─────────────────────────────────────────────────────────────────

interface OverCasesDatum {
  idx: number
  ttft: number | null
  ttfb: number | null
  duration: number | null
  status: CaseStatus
}

const CHART_TOOLTIP_STYLE = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 11,
} as const

const AXIS_TICK = { fill: 'var(--muted-foreground)', fontSize: 10 } as const

function LatencyOverCasesChart({
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
          <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="idx" tick={AXIS_TICK} stroke="var(--border)" tickLine={false} />
          <YAxis
            tickFormatter={(v: number) => formatMs(v)}
            tick={AXIS_TICK}
            stroke="var(--border)"
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

// Pipeline breakdown for voice runs (stacked TTFT + TTFB), duration-per-
// case for text runs. Same axes structure; the bars + Y-axis formatter
// differ. Two charts share one panel because the only meaningful
// difference is *which* timing series to bar, and voice/text already
// answers that.
function PipelineOrDurationChart({
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
          <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="idx" tick={AXIS_TICK} stroke="var(--border)" tickLine={false} />
          <YAxis
            tickFormatter={(v: number) => yFormatter(v)}
            tick={AXIS_TICK}
            stroke="var(--border)"
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

function TokenCostPanel({ run }: { run: EvalRunDetail }) {
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
                <Cell fill="var(--muted)" />
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

// ── Cases table ────────────────────────────────────────────────────────────

// Columns drive the header AND the empty-state colspan, so adding a
// column is a one-line change — not three sites that have to agree.
function caseColumns(view: MetricsView): { k: string; label: string; cls?: string }[] {
  return [
    { k: 'sel', label: '' },
    { k: 'name', label: 'Name', cls: 'text-left' },
    { k: 'status', label: 'Status' },
    { k: 'duration', label: 'Duration' },
    { k: 'ttft', label: 'TTFT' },
    ...(view === 'voice' ? [{ k: 'ttfb', label: 'TTFB' }] : []),
    { k: 'tokens', label: 'Tokens' },
    { k: 'cache', label: 'Cache %' },
    { k: 'cost', label: 'Cost' },
    { k: 'tools', label: 'Tools' },
    { k: 'asr', label: 'ASR conf.' },
    { k: 'events', label: 'Events' },
    { k: 'chev', label: '' },
  ]
}

function CasesTable({
  cases,
  view,
  selectedSet,
  allVisibleSelected,
  onToggleAllVisible,
  onToggleCase,
  onRowClick,
  emptyStateText,
}: {
  cases: EnrichedCase[]
  view: MetricsView
  selectedSet: Set<string>
  allVisibleSelected: boolean
  onToggleAllVisible: (checked: boolean) => void
  onToggleCase: (caseId: string, checked: boolean) => void
  onRowClick: (caseId: string) => void
  emptyStateText: string
}) {
  const cols = caseColumns(view)
  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <table className="w-full text-[12px] border-collapse">
        <thead>
          <tr className="text-muted-foreground">
            {cols.map((h) => (
              <th
                key={h.k}
                className={cn(
                  'h-9 px-3.5 text-[10px] font-semibold tracking-[0.12em] uppercase border-b border-border bg-card whitespace-nowrap',
                  h.cls ?? 'text-left',
                )}
              >
                {h.k === 'sel' ? (
                  <Checkbox
                    checked={allVisibleSelected}
                    onCheckedChange={(checked) => onToggleAllVisible(checked === true)}
                    aria-label="Select all visible cases"
                  />
                ) : (
                  h.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <CaseRow
              key={c.case_id}
              c={c}
              view={view}
              selected={selectedSet.has(c.case_id)}
              onToggle={(checked) => onToggleCase(c.case_id, checked)}
              onClick={() => onRowClick(c.case_id)}
            />
          ))}
          {cases.length === 0 && (
            <tr>
              <td colSpan={cols.length} className="px-4 py-10 text-center text-muted-foreground">
                {emptyStateText}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function CaseRow({
  c,
  view,
  selected,
  onToggle,
  onClick,
}: {
  c: EnrichedCase
  view: MetricsView
  selected: boolean
  onToggle: (checked: boolean) => void
  onClick: () => void
}) {
  const { ttftBad, ttfbBad, asrBad, asrWarn, hasInterrupt } = c
  return (
    <tr onClick={onClick} className="cursor-pointer transition-colors hover:bg-muted/40">
      <td className="h-10 px-3.5 border-b border-border" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onToggle(checked === true)}
          aria-label={`Select case ${c.name}`}
        />
      </td>
      <td className="h-10 px-3.5 border-b border-border font-mono text-[12px] truncate max-w-[420px]">
        {c.name}
      </td>
      <td className="h-10 px-3.5 border-b border-border">
        <StatusDot status={c.status} />
      </td>
      <td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-muted-foreground">
        {formatDuration(c.duration_ms)}
      </td>
      <td
        className={cn(
          'h-10 px-3.5 border-b border-border font-mono tabular-nums',
          ttftBad ? 'text-destructive' : 'text-foreground/85',
        )}
      >
        {c.ttft_avg_ms != null ? formatMs(c.ttft_avg_ms) : '—'}
      </td>
      {view === 'voice' && (
        <td
          className={cn(
            'h-10 px-3.5 border-b border-border font-mono tabular-nums',
            ttfbBad ? 'text-destructive' : 'text-foreground/85',
          )}
        >
          {c.ttfb_avg_ms != null ? formatMs(c.ttfb_avg_ms) : '—'}
        </td>
      )}
      <td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-foreground/85">
        {formatTokens(c.total_tokens)}
      </td>
      <td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-foreground/85">
        {c.prompt_tokens > 0
          ? `${Math.round((c.cached_prompt_tokens / c.prompt_tokens) * 100)}%`
          : '—'}
      </td>
      <td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-foreground/85">
        {formatCost(c.estimated_cost_usd)}
      </td>
      <td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-muted-foreground">
        {c.tool_call_count != null && c.tool_call_count > 0 ? c.tool_call_count : '—'}
      </td>
      <td className="h-10 px-3.5 border-b border-border">
        {c.asr == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <span
              className={cn(
                'font-mono tabular-nums',
                asrBad
                  ? 'text-destructive'
                  : asrWarn
                    ? 'text-warning-fg'
                    : 'text-success-fg',
              )}
            >
              {(c.asr * 100).toFixed(1)}%
            </span>
            {hasInterrupt && (
              <span className="inline-flex items-center px-1.5 h-[18px] rounded bg-warning-bg text-warning-fg border border-warning-border text-[10px] font-medium tracking-wide">
                intr
              </span>
            )}
          </span>
        )}
      </td>
      <td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-muted-foreground">
        {c.events.length}
      </td>
      <td className="h-10 px-3.5 border-b border-border text-muted-foreground/60">›</td>
    </tr>
  )
}

// ── Delete confirmation dialog ─────────────────────────────────────────────

function DeleteCasesDialog({
  open,
  onOpenChange,
  count,
  deleting,
  error,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  count: number
  deleting: boolean
  error: string | null
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !deleting && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Delete {count} case{count === 1 ? '' : 's'}?
          </DialogTitle>
          <DialogDescription>
            This permanently removes the selected case{count === 1 ? '' : 's'} and
            every event and judgment captured under {count === 1 ? 'it' : 'them'}.
            This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <div className="text-s-400 text-destructive">
            Failed to delete: {error}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="text-destructive border-destructive-border hover:bg-destructive-bg"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : `Delete ${count}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Main page component ────────────────────────────────────────────────────

export const EvalRunDetailPage = ({
  runId,
  onCaseClick,
}: {
  runId: string
  onCaseClick?: (caseId: string) => void
}) => {
  const { run, loading, error, refetch } = useEvalRun(runId)
  const [openCaseId, setOpenCaseId] = useQueryState('case', parseAsString)
  const [localOpenCaseId, setLocalOpenCaseId] = useState<string | null>(null)
  const drawerCaseId = openCaseId ?? localOpenCaseId
  const [caseSearch, setCaseSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const { api } = useObservabilityContext()
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const hasRunningRun = run?.status === 'running'

  useEffect(() => {
    if (!hasRunningRun) return
    const id = window.setInterval(() => refetch(), 1500)
    return () => window.clearInterval(id)
  }, [hasRunningRun, refetch])

  const handleRowClick = (caseId: string) => {
    if (onCaseClick) onCaseClick(caseId)
    else if (openCaseId !== undefined) void setOpenCaseId(caseId)
    else setLocalOpenCaseId(caseId)
  }
  const closeDrawer = () => {
    if (openCaseId !== null) void setOpenCaseId(null)
    setLocalOpenCaseId(null)
  }

  const enriched: EnrichedCase[] = useMemo(() => {
    if (!run) return []
    return run.cases.map((c) => {
      const asr = caseAsrConfidence(c.events)
      let judgePass = 0
      let judgeFail = 0
      for (const j of c.judgments) {
        if (j.verdict === 'pass') judgePass += 1
        else if (j.verdict === 'fail') judgeFail += 1
      }
      return {
        ...c,
        asr,
        judgePass,
        judgeFail,
        ttftBad: c.ttft_avg_ms != null && c.ttft_avg_ms > TTFT_BAD_MS,
        ttfbBad: c.ttfb_avg_ms != null && c.ttfb_avg_ms > TTFB_BAD_MS,
        asrBad: asr != null && asr < ASR_BAD,
        asrWarn: asr != null && asr >= ASR_BAD && asr < ASR_WARN,
        hasInterrupt: (c.interruption_count ?? 0) > 0,
      }
    })
  }, [run])

  const view: MetricsView = useMemo(
    () => (run ? detectMetricsView(run, enriched) : 'text'),
    [run, enriched],
  )

  const stats: RunStats | null = useMemo(() => {
    if (!run) return null
    const passRate = run.total > 0 ? (run.passed / run.total) * 100 : 0
    let totalToolCalls = 0
    let totalInterrupts = 0
    let asrSum = 0
    let asrCount = 0
    for (const c of enriched) {
      totalToolCalls += c.tool_call_count ?? 0
      totalInterrupts += c.interruption_count ?? 0
      if (c.asr != null) {
        asrSum += c.asr
        asrCount += 1
      }
    }
    const avgAsr = asrCount > 0 ? asrSum / asrCount : null
    return {
      passRate,
      totalToolCalls,
      totalInterrupts,
      avgToolCallsPerCase: run.total > 0 ? totalToolCalls / run.total : 0,
      avgTokensPerCase: run.total > 0 ? Math.round(run.total_tokens / run.total) : 0,
      avgCostPerCase:
        run.total > 0 && run.estimated_cost_usd != null
          ? run.estimated_cost_usd / run.total
          : null,
      avgAsr,
    }
  }, [run, enriched])

  const overCasesData: OverCasesDatum[] = useMemo(
    () =>
      enriched.map((c, i) => ({
        idx: i + 1,
        ttft: c.ttft_avg_ms,
        ttfb: c.ttfb_avg_ms,
        duration: c.duration_ms,
        status: c.status,
      })),
    [enriched],
  )

  const filteredCases = useMemo(() => {
    let cases = enriched
    if (statusFilter !== 'all') cases = cases.filter((c) => c.status === statusFilter)
    const q = caseSearch.trim().toLowerCase()
    if (q) cases = cases.filter((c) => c.name.toLowerCase().includes(q))
    return cases
  }, [enriched, caseSearch, statusFilter])

  const selectedSet = useMemo(() => new Set(selectedCaseIds), [selectedCaseIds])
  const selectedCount = selectedCaseIds.length
  const selectedInViewCount = filteredCases.reduce(
    (count, c) => count + (selectedSet.has(c.case_id) ? 1 : 0),
    0,
  )
  const allVisibleSelected =
    filteredCases.length > 0 && selectedInViewCount === filteredCases.length

  const toggleCaseSelected = (caseId: string, checked: boolean) => {
    setSelectedCaseIds((prev) => {
      if (checked) return prev.includes(caseId) ? prev : [...prev, caseId]
      return prev.filter((id) => id !== caseId)
    })
  }
  const toggleAllVisibleSelected = (checked: boolean) => {
    setSelectedCaseIds((prev) => {
      if (checked) {
        const next = new Set(prev)
        for (const c of filteredCases) next.add(c.case_id)
        return Array.from(next)
      }
      const visibleIds = new Set(filteredCases.map((c) => c.case_id))
      return prev.filter((id) => !visibleIds.has(id))
    })
  }

  const handleDeleteCases = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await api.deleteEvalCases(runId, selectedCaseIds)
      setSelectedCaseIds([])
      setConfirmOpen(false)
      closeDrawer()
      await refetch()
    } catch (e) {
      setDeleteError((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-5 p-6" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] rounded-lg" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <Skeleton className="h-[230px] rounded-lg" />
          <Skeleton className="h-[230px] rounded-lg" />
          <Skeleton className="h-[230px] rounded-lg" />
        </div>
      </div>
    )
  }

  if (error || !run || !stats) {
    return (
      <div className="p-12 text-center text-foreground">
        <p>Failed to load eval run: {error ?? 'not found'}</p>
        <div className="mt-4">
          <Link to="/" className="text-link underline">
            Agents
          </Link>
        </div>
      </div>
    )
  }

  const displayName = run.name ?? run.agent_id ?? run.run_id.slice(0, 8)
  // Mono when displayName is an id (uuid agent_id or hash); sans when
  // it's a human-readable run name set via --agent-observability-run-name.
  const displayNameIsId = run.name == null

  return (
    <div className="p-6 flex flex-col gap-4 relative">
      {run.agent_id && (
        <AgentScopeHeader
          agentId={run.agent_id}
          trail={[
            {
              label: 'Simulation Evals',
              to: `/agents/${encodeURIComponent(run.agent_id)}?tab=simulation-evals`,
            },
            { label: displayName, mono: displayNameIsId },
          ]}
        />
      )}

      <RunMetaStrip run={run} />

      <KpiStrip run={run} stats={stats} view={view} />

      {overCasesData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <LatencyOverCasesChart data={overCasesData} view={view} />
          <PipelineOrDurationChart data={overCasesData} view={view} />
          <TokenCostPanel run={run} />
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <h2 className="text-[14px] font-semibold tracking-tight">
            Cases{' '}
            <span className="text-muted-foreground font-normal text-[12px]">
              ({filteredCases.length} of {run.cases.length})
            </span>
          </h2>
          <div className="flex items-center gap-2">
            {selectedCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-destructive [&_svg]:text-current border-destructive-border hover:bg-destructive-bg"
                onClick={() => setConfirmOpen(true)}
              >
                <Trash2 /> Delete {selectedCount}
              </Button>
            )}
            <input
              type="text"
              placeholder="Search name…"
              value={caseSearch}
              onChange={(e) => setCaseSearch(e.target.value)}
              className="h-8 w-56 rounded-md border border-border bg-card px-3 text-[12px] outline-none focus:ring-1 focus:ring-ring"
            />
            <FilterPill active={statusFilter} onChange={setStatusFilter} />
          </div>
        </div>

        <CasesTable
          cases={filteredCases}
          view={view}
          selectedSet={selectedSet}
          allVisibleSelected={allVisibleSelected}
          onToggleAllVisible={toggleAllVisibleSelected}
          onToggleCase={toggleCaseSelected}
          onRowClick={handleRowClick}
          emptyStateText={
            statusFilter !== 'all' || caseSearch.trim()
              ? 'No cases match the current filter.'
              : 'No cases in this run.'
          }
        />
      </div>

      <DeleteCasesDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        count={selectedCount}
        deleting={deleting}
        error={deleteError}
        onConfirm={handleDeleteCases}
      />

      {!onCaseClick && (
        <Sheet
          open={!!drawerCaseId}
          onOpenChange={(open) => {
            if (!open) closeDrawer()
          }}
        >
          <SheetContent
            className="w-full sm:max-w-2xl md:max-w-3xl overflow-y-auto p-0"
            showCloseButton={false}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Case detail</SheetTitle>
            </SheetHeader>
            {drawerCaseId && (
              <EvalCaseDetailPage
                runId={runId}
                caseId={drawerCaseId}
                onBack={closeDrawer}
              />
            )}
          </SheetContent>
        </Sheet>
      )}
    </div>
  )
}
