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
  formatCost,
  formatDate,
  formatDuration,
  formatMs,
  formatTokens,
} from '@/lib/observability-format'
import { useEvalRun } from '@/lib/observability-hooks'
import { useObservabilityContext } from '@/lib/observability-provider'
import type { CaseStatus, EvalCaseRow, RunEvent } from '@/lib/observability-types'
import { EvalCaseDetailPage } from '@/components/eval-case-detail-page'

// Split a ms value into a numeric part and unit so callers can render the
// unit subdued without re-parsing the formatted string.
function fmtMsParts(ms: number | null | undefined): { value: string; unit: string | null } {
  if (ms == null) return { value: '—', unit: null }
  if (ms < 1) return { value: '<1', unit: 'ms' }
  if (ms < 1000) return { value: String(Math.round(ms)), unit: 'ms' }
  return { value: (ms / 1000).toFixed(2), unit: 's' }
}

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

type ValueTone = 'default' | 'good' | 'warn' | 'bad' | 'mute'
const valueToneClass: Record<ValueTone, string> = {
  default: 'text-foreground',
  good: 'text-[hsl(var(--success-fg,var(--success)))]',
  warn: 'text-[hsl(var(--warning-fg,var(--warning)))]',
  bad: 'text-[hsl(var(--destructive))]',
  mute: 'text-muted-foreground',
}

function Kpi({
  label,
  value,
  unit,
  hint,
  hintTone = 'mute',
  valueTone = 'default',
}: {
  label: string
  value: string | number
  unit?: string
  hint?: string
  hintTone?: ValueTone
  valueTone?: ValueTone
}) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3.5 flex flex-col gap-1.5 min-w-0">
      <span className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
        {label}
      </span>
      <div className="flex items-baseline gap-1.5">
        <span
          className={cn(
            'text-[28px] leading-none font-semibold tabular-nums tracking-tight',
            valueToneClass[valueTone],
          )}
        >
          {value}
        </span>
        {unit && (
          <span className="text-[12px] text-muted-foreground tabular-nums">{unit}</span>
        )}
      </div>
      {hint && (
        <span className={cn('text-[11px] tabular-nums', valueToneClass[hintTone])}>
          {hint}
        </span>
      )}
    </div>
  )
}

const STATUS_DOT: Record<CaseStatus, { dot: string; text: string }> = {
  passed: {
    dot: 'bg-[hsl(var(--success-fg,var(--success)))]',
    text: 'text-[hsl(var(--success-fg,var(--success)))]',
  },
  failed: {
    dot: 'bg-[hsl(var(--destructive))]',
    text: 'text-[hsl(var(--destructive))]',
  },
  errored: {
    dot: 'bg-[hsl(var(--warning-fg,var(--warning)))]',
    text: 'text-[hsl(var(--warning-fg,var(--warning)))]',
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
        <span className="text-[13px] font-medium">{title}</span>
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

const TTFT_BAD_MS = 10_000
const TTFB_BAD_MS = 1_500
const ASR_BAD = 0.88
const ASR_WARN = 0.92

const COLOR_TTFT = 'hsl(var(--accent-purple))'
const COLOR_TTFB = 'hsl(var(--success-fg,var(--success)))'

const latencyTone = (ms: number | null, badMs: number): ValueTone =>
  ms == null ? 'mute' : ms > badMs ? 'bad' : 'default'

const asrTone = (avg: number | null): ValueTone => {
  if (avg == null) return 'mute'
  if (avg < ASR_BAD) return 'bad'
  if (avg < ASR_WARN) return 'warn'
  return 'good'
}

const passRateTone = (pct: number): ValueTone =>
  pct >= 90 ? 'good' : pct >= 70 ? 'warn' : 'bad'

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
            'px-3 h-full rounded-[5px] transition capitalize',
            active === it
              ? 'bg-foreground text-background font-medium'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {it}
        </button>
      ))}
    </div>
  )
}

export const EvalRunDetailPage = ({
  runId,
  onBack: _onBack,
  onCaseClick,
}: {
  runId: string
  onBack?: () => void
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
  const [deletedCaseIds, setDeletedCaseIds] = useState<string[]>([])
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

  const stats = useMemo(() => {
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

  const overCasesData = useMemo(
    () =>
      enriched.map((c, i) => ({
        idx: i + 1,
        ttft: c.ttft_avg_ms,
        ttfb: c.ttfb_avg_ms,
      })),
    [enriched],
  )

  const filteredCases = useMemo(() => {
    const deletedIds = new Set(deletedCaseIds)
    let cases = enriched.filter((c) => !deletedIds.has(c.case_id))
    if (statusFilter !== 'all') cases = cases.filter((c) => c.status === statusFilter)
    const q = caseSearch.trim().toLowerCase()
    if (q) cases = cases.filter((c) => c.name.toLowerCase().includes(q))
    return cases
  }, [enriched, caseSearch, deletedCaseIds, statusFilter])

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
      setDeletedCaseIds((prev) => [...prev, ...selectedCaseIds])
      setSelectedCaseIds([])
      setConfirmOpen(false)
      closeDrawer()
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
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2.5">
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
          <Link to="/evals" className="text-link underline">
            Evals
          </Link>
        </div>
      </div>
    )
  }

  const ttftParts = fmtMsParts(run.ttft_p95_ms)
  const ttfbParts = fmtMsParts(run.ttfb_p95_ms)

  const branch = run.ci?.git_branch ? String(run.ci.git_branch) : null
  const sha = run.ci?.git_sha ? String(run.ci.git_sha).slice(0, 7) : null
  const runShort = `${run.run_id.slice(0, 8)}…${run.run_id.slice(-4)}`

  const displayName = run.name ?? run.agent_id ?? run.run_id.slice(0, 8)

  return (
    <div className="p-6 flex flex-col gap-4 relative">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <Link
            to={
              run.agent_id ? `/evals/agents/${encodeURIComponent(run.agent_id)}` : '/evals'
            }
            className="text-[13px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <span className="text-[11px]">‹</span> Runs
          </Link>
          <span className="text-muted-foreground/60 text-[13px]">/</span>
          <span className="font-mono text-[14px] font-semibold tracking-tight truncate max-w-[420px]">
            {displayName}
          </span>
          {run.framework && (
            <span className="ml-1 inline-flex shrink-0 items-center gap-1.5 px-2 h-6 rounded-full border bg-card text-[11px] text-muted-foreground">
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

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5">
        <Kpi
          label="Pass rate"
          value={stats.passRate.toFixed(0)}
          unit="%"
          valueTone={passRateTone(stats.passRate)}
          hint={`${run.passed}✓ ${run.failed > 0 ? ` · ${run.failed}✗` : ''}`}
        />
        <Kpi
          label="Cases"
          value={run.total}
          hint={`${run.passed}✓${run.failed ? ` · ${run.failed}✗` : ''}${run.errored ? ` · ${run.errored}!` : ''}`}
        />
        <Kpi
          label="P95 TTFT"
          value={ttftParts.value}
          unit={ttftParts.unit ?? undefined}
          valueTone={latencyTone(run.ttft_p95_ms, TTFT_BAD_MS)}
          hint={run.ttft_avg_ms != null ? `avg ${formatMs(run.ttft_avg_ms)}` : undefined}
        />
        <Kpi
          label="P95 TTFB"
          value={ttfbParts.value}
          unit={ttfbParts.unit ?? undefined}
          valueTone={latencyTone(run.ttfb_p95_ms, TTFB_BAD_MS)}
          hint={run.ttfb_avg_ms != null ? `avg ${formatMs(run.ttfb_avg_ms)}` : undefined}
        />
        <Kpi
          label="Tokens"
          value={formatTokens(run.total_tokens)}
          hint={
            run.total_tokens > 0
              ? `${stats.avgTokensPerCase.toLocaleString()} avg/case`
              : undefined
          }
          valueTone={run.total_tokens === 0 ? 'mute' : 'default'}
        />
        <Kpi
          label="Cost"
          value={formatCost(run.estimated_cost_usd)}
          hint={
            stats.avgCostPerCase != null
              ? `$${stats.avgCostPerCase.toFixed(4)}/case`
              : undefined
          }
          valueTone={run.estimated_cost_usd == null ? 'mute' : 'default'}
        />
        <Kpi
          label="Tool calls"
          value={stats.totalToolCalls > 0 ? stats.totalToolCalls : '—'}
          hint={
            stats.totalToolCalls > 0
              ? `${stats.avgToolCallsPerCase.toFixed(1)} avg/case`
              : undefined
          }
          valueTone={stats.totalToolCalls === 0 ? 'mute' : 'default'}
        />
        <Kpi
          label="ASR conf."
          value={stats.avgAsr != null ? (stats.avgAsr * 100).toFixed(1) : '—'}
          unit={stats.avgAsr != null ? '%' : undefined}
          valueTone={asrTone(stats.avgAsr)}
          hint={
            stats.totalInterrupts > 0
              ? `${stats.totalInterrupts} interrupt${stats.totalInterrupts === 1 ? '' : 's'}`
              : undefined
          }
          hintTone={stats.totalInterrupts > 0 ? 'warn' : 'mute'}
        />
      </div>

      {overCasesData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Latency over cases (line) */}
          <Panel
            title="Latency over cases"
            legend={[
              { color: COLOR_TTFT, label: 'TTFT' },
              { color: COLOR_TTFB, label: 'TTFB' },
            ]}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={overCasesData} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="idx"
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                  stroke="hsl(var(--border))"
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={(v: number) => formatMs(v)}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                  stroke="hsl(var(--border))"
                  tickLine={false}
                  width={42}
                />
                <Tooltip
                  formatter={(v: unknown) => formatMs(Number(v))}
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 6,
                    fontSize: 11,
                  }}
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
                <Line
                  type="monotone"
                  dataKey="ttfb"
                  name="TTFB"
                  stroke={COLOR_TTFB}
                  strokeWidth={1.75}
                  dot={false}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </Panel>

          {/* Pipeline breakdown (stacked bars) */}
          <Panel
            title="Pipeline breakdown"
            legend={[
              { color: COLOR_TTFT, label: 'TTFT' },
              { color: COLOR_TTFB, label: 'TTFB' },
            ]}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={overCasesData}
                margin={{ top: 8, right: 8, left: 0, bottom: 4 }}
                barCategoryGap={3}
              >
                <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="idx"
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                  stroke="hsl(var(--border))"
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={(v: number) => formatMs(v)}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                  stroke="hsl(var(--border))"
                  tickLine={false}
                  width={42}
                />
                <Tooltip
                  formatter={(v: unknown) => formatMs(Number(v))}
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 6,
                    fontSize: 11,
                  }}
                />
                <Bar dataKey="ttft" stackId="lat" fill={COLOR_TTFT} radius={[0, 0, 0, 0]} />
                <Bar dataKey="ttfb" stackId="lat" fill={COLOR_TTFB} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Panel>

          {/* Token & cost (donut) */}
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
                className="h-8 text-[hsl(var(--destructive))] [&_svg]:text-current border-[hsl(var(--destructive-border))] hover:bg-[hsl(var(--destructive-bg))]"
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

        <div className="rounded-lg border bg-card overflow-hidden">
          <table className="w-full text-[12px] border-collapse">
            <thead>
              <tr className="text-muted-foreground">
                {[
                  { k: 'sel', label: '' },
                  { k: 'name', label: 'Name', cls: 'text-left' },
                  { k: 'status', label: 'Status' },
                  { k: 'duration', label: 'Duration' },
                  { k: 'ttft', label: 'TTFT' },
                  { k: 'ttfb', label: 'TTFB' },
                  { k: 'tokens', label: 'Tokens' },
                  { k: 'cost', label: 'Cost' },
                  { k: 'tools', label: 'Tools' },
                  { k: 'asr', label: 'ASR conf.' },
                  { k: 'events', label: 'Events' },
                  { k: 'chev', label: '' },
                ].map((h) => (
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
                        onCheckedChange={(checked) =>
                          toggleAllVisibleSelected(checked === true)
                        }
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
              {filteredCases.map((c) => {
                const { ttftBad, ttfbBad, asrBad, asrWarn, hasInterrupt } = c
                return (
                  <tr
                    key={c.case_id}
                    onClick={() => handleRowClick(c.case_id)}
                    className="cursor-pointer transition-colors hover:bg-muted/40"
                  >
                    <td
                      className="h-10 px-3.5 border-b border-border"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={selectedSet.has(c.case_id)}
                        onCheckedChange={(checked) =>
                          toggleCaseSelected(c.case_id, checked === true)
                        }
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
                        ttftBad
                          ? 'text-[hsl(var(--destructive))]'
                          : 'text-foreground/85',
                      )}
                    >
                      {c.ttft_avg_ms != null ? formatMs(c.ttft_avg_ms) : '—'}
                    </td>
                    <td
                      className={cn(
                        'h-10 px-3.5 border-b border-border font-mono tabular-nums',
                        ttfbBad
                          ? 'text-[hsl(var(--destructive))]'
                          : 'text-foreground/85',
                      )}
                    >
                      {c.ttfb_avg_ms != null ? formatMs(c.ttfb_avg_ms) : '—'}
                    </td>
                    <td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-foreground/85">
                      {formatTokens(c.total_tokens)}
                    </td>
                    <td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-foreground/85">
                      {formatCost(c.estimated_cost_usd)}
                    </td>
                    <td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-muted-foreground">
                      {c.tool_call_count != null && c.tool_call_count > 0
                        ? c.tool_call_count
                        : '—'}
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
                                ? 'text-[hsl(var(--destructive))]'
                                : asrWarn
                                  ? 'text-[hsl(var(--warning-fg,var(--warning)))]'
                                  : 'text-[hsl(var(--success-fg,var(--success)))]',
                            )}
                          >
                            {(c.asr * 100).toFixed(1)}%
                          </span>
                          {hasInterrupt && (
                            <span className="inline-flex items-center px-1.5 h-[18px] rounded bg-[hsl(var(--warning-bg))] text-[hsl(var(--warning-fg,var(--warning)))] border border-[hsl(var(--warning-border))] text-[10px] font-medium tracking-wide">
                              intr
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-muted-foreground">
                      {c.events.length}
                    </td>
                    <td className="h-10 px-3.5 border-b border-border text-muted-foreground/60">
                      ›
                    </td>
                  </tr>
                )
              })}
              {filteredCases.length === 0 && (
                <tr>
                  <td
                    colSpan={12}
                    className="px-4 py-10 text-center text-muted-foreground"
                  >
                    No cases match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={(open) => !deleting && setConfirmOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {selectedCount} case{selectedCount === 1 ? '' : 's'}?
            </DialogTitle>
            <DialogDescription>
              This permanently removes the selected case
              {selectedCount === 1 ? '' : 's'} and every event and judgment captured under{' '}
              {selectedCount === 1 ? 'it' : 'them'}. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <div className="text-s-400 text-[hsl(var(--destructive))]">
              Failed to delete: {deleteError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="outline"
              className="text-[hsl(var(--destructive))] border-[hsl(var(--destructive-border))] hover:bg-[hsl(var(--destructive-bg))]"
              onClick={handleDeleteCases}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : `Delete ${selectedCount}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
