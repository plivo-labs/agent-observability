import { useEffect, useMemo, useState } from 'react'
import { parseAsString, useQueryState } from 'nuqs'
import { Bot, ExternalLink, FlaskConical, GitBranch, GitCommit, Trash2 } from 'lucide-react'
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
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { formatDate, formatDuration, formatMs } from '@/lib/observability-format'
import { useEvalRun } from '@/lib/observability-hooks'
import { useObservabilityContext } from '@/lib/observability-provider'
import type { CaseStatus } from '@/lib/observability-types'
import { ChartCard } from '@/components/observability-chart-shared'
import { EvalCaseDetailPage } from '@/components/eval-case-detail-page'

function formatTokens(tokens: number): string {
  return tokens > 0 ? tokens.toLocaleString() : '—'
}

function formatCost(cost: number | null): string {
  return cost == null ? '—' : `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`
}

const STATUS_TONE: Record<CaseStatus, string> = {
  passed:
    'bg-[hsl(var(--success-bg))] text-[hsl(var(--success-fg,var(--success)))] border-[hsl(var(--success-border))]',
  failed:
    'bg-[hsl(var(--destructive-bg))] text-[hsl(var(--destructive))] border-[hsl(var(--destructive-border))]',
  errored:
    'bg-[hsl(var(--warning-bg))] text-[hsl(var(--warning-fg,var(--warning)))] border-[hsl(var(--warning-border))]',
  skipped: 'bg-muted text-muted-foreground border-border',
}

const CHART_COLORS = {
  ttft: 'hsl(var(--accent-purple))',
  ttfb: 'hsl(var(--success))',
}

function StatusChip({ status }: { status: CaseStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center h-[22px] px-2 rounded-full border text-xxs-600 capitalize',
        STATUS_TONE[status],
      )}
    >
      {status}
    </span>
  )
}

type StatTone = 'good' | 'warn' | 'bad' | 'zero' | 'default'

/** Card tones mirror the session-detail metric tiles: good/warn/bad pick
 * up the semantic token family (success / warning / destructive). `zero`
 * mutes the value so 0 counts don't compete with real signals. */
function StatCard({
  label,
  value,
  suffix,
  tone = 'default',
  meterPct,
}: {
  label: string
  value: string | number
  suffix?: string
  tone?: StatTone
  meterPct?: number
}) {
  const valueClass =
    tone === 'good'
      ? 'text-[hsl(var(--success-fg,var(--success)))]'
      : tone === 'warn'
        ? 'text-[hsl(var(--warning-fg,var(--warning)))]'
        : tone === 'bad'
          ? 'text-[hsl(var(--destructive))]'
          : tone === 'zero'
            ? 'text-muted-foreground'
            : ''
  const borderClass =
    tone === 'good'
      ? 'border-[hsl(var(--success-border))]'
      : tone === 'warn'
        ? 'border-[hsl(var(--warning-border))]'
        : tone === 'bad'
          ? 'border-[hsl(var(--destructive-border))]'
          : ''
  const meterClass =
    tone === 'good'
      ? 'bg-[hsl(var(--success-fg,var(--success)))]'
      : tone === 'warn'
        ? 'bg-[hsl(var(--warning-fg,var(--warning)))]'
        : tone === 'bad'
          ? 'bg-[hsl(var(--destructive))]'
          : 'bg-foreground'
  return (
    <Card className={cn('relative overflow-hidden', borderClass)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs-600 uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn('text-h1-600 font-semibold tabular-nums flex items-baseline gap-2', valueClass)}>
          {value}
          {suffix && <span className="text-p-500 text-muted-foreground">{suffix}</span>}
        </div>
        {meterPct != null && (
          <div className="absolute left-0 right-0 bottom-0 h-[3px] bg-muted">
            <div
              className={cn('h-full', meterClass)}
              style={{ width: `${Math.max(0, Math.min(100, meterPct))}%` }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Pass-rate card tone matches the session-detail latency scale:
 * 100% good, ≥ 70% warn, below bad. */
function passRateTone(pct: number): StatTone {
  if (pct >= 100) return 'good'
  if (pct >= 70) return 'warn'
  return 'bad'
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

  const stats = useMemo(() => {
    if (!run) return null
    const passRate = run.total > 0 ? Math.round((run.passed / run.total) * 100) : 0
    const totalToolCalls = run.cases.reduce((sum, c) => sum + (c.tool_call_count ?? 0), 0)
    return {
      passRate,
      hasAnyFailure: run.failed > 0 || run.errored > 0,
      passedPct: run.total > 0 ? (run.passed / run.total) * 100 : 0,
      failedPct: run.total > 0 ? (run.failed / run.total) * 100 : 0,
      totalToolCalls,
      avgToolCallsPerCase: run.total > 0 ? (totalToolCalls / run.total).toFixed(1) : null,
      avgTokensPerCase: run.total > 0 ? Math.round(run.total_tokens / run.total) : null,
      avgCostPerCase: run.total > 0 && run.estimated_cost_usd != null
        ? run.estimated_cost_usd / run.total
        : null,
    }
  }, [run])

  const percentilesData = useMemo(() => {
    if (!run) return []
    return [
      { name: 'TTFT', avg: run.ttft_avg_ms ?? 0, p50: run.ttft_p50_ms ?? 0, p95: run.ttft_p95_ms ?? 0 },
      { name: 'TTFB', avg: run.ttfb_avg_ms ?? 0, p50: run.ttfb_p50_ms ?? 0, p95: run.ttfb_p95_ms ?? 0 },
    ].filter((d) => d.avg > 0 || d.p50 > 0 || d.p95 > 0)
  }, [run])

  const overCasesData = useMemo(() => {
    if (!run) return []
    return run.cases.map((c, i) => ({
      idx: i + 1,
      ttft: c.ttft_avg_ms,
      ttfb: c.ttfb_avg_ms,
    }))
  }, [run])

  const filteredCases = useMemo(() => {
    const deletedIds = new Set(deletedCaseIds)
    const cases = (run?.cases ?? []).filter((c) => !deletedIds.has(c.case_id))
    const q = caseSearch.trim().toLowerCase()
    return q ? cases.filter((c) => c.name.toLowerCase().includes(q)) : cases
  }, [run, caseSearch, deletedCaseIds])

  const selectedSet = useMemo(() => new Set(selectedCaseIds), [selectedCaseIds])
  const selectedCount = selectedCaseIds.length
  const selectedInViewCount = filteredCases.reduce(
    (count, c) => count + (selectedSet.has(c.case_id) ? 1 : 0),
    0,
  )
  const allVisibleSelected = filteredCases.length > 0 && selectedInViewCount === filteredCases.length

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
        for (const evalCase of filteredCases) next.add(evalCase.case_id)
        return Array.from(next)
      }
      const visibleIds = new Set(filteredCases.map((evalCase) => evalCase.case_id))
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
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[110px] rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-[300px] w-full rounded-xl" />
      </div>
    )
  }

  if (error || !run || !stats) {
    return (
      <div className="p-12 text-center text-foreground">
        <p>Failed to load eval run: {error ?? 'not found'}</p>
        <div className="eval-breadcrumbs mt-4 justify-center">
          <Link to="/evals">Evals</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 flex flex-col gap-5 relative">
      <div className="eval-breadcrumbs">
        <Link to="/evals">Evals</Link>
        {run.agent_id && (
          <>
            <span className="eval-breadcrumbs__sep">/</span>
            <Link to={`/evals/agents/${encodeURIComponent(run.agent_id)}`}>{run.agent_id}</Link>
          </>
        )}
        <span className="eval-breadcrumbs__sep">/</span>
        <span className="eval-breadcrumbs__current">{run.name ?? runId.slice(0, 8)}</span>
      </div>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <h1 className="text-h2-600 font-semibold m-0">
              {run.name ?? run.agent_id ?? <span className="text-muted-foreground">—</span>}
            </h1>
            {run.framework && (
              <span className="inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted border text-xs-500 whitespace-nowrap">
                <Bot className="h-3 w-3 shrink-0 text-muted-foreground" />
                {run.framework}
                {run.framework_version && (
                  <span className="text-muted-foreground font-mono text-[11px]">
                    {run.framework_version}
                  </span>
                )}
              </span>
            )}
            <span className="inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted border text-xs-500 whitespace-nowrap">
              <FlaskConical className="h-3 w-3 shrink-0 text-muted-foreground" />
              {run.testing_framework}
              {run.testing_framework_version && (
                <span className="text-muted-foreground font-mono text-[11px]">
                  {run.testing_framework_version}
                </span>
              )}
            </span>
          </div>
          <div className="font-mono text-xs-400 text-muted-foreground">{run.run_id}</div>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <b className="block text-foreground text-s-600">
            Started {formatDate(run.started_at)}
          </b>
          <span>Duration {formatDuration(run.duration_ms)}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 lg:grid-cols-5 gap-3">
        <StatCard
          label="Pass rate"
          value={stats.passRate}
          suffix="%"
          tone={passRateTone(stats.passRate)}
          meterPct={stats.passRate}
        />
        <StatCard
          label="Passed"
          value={run.passed}
          tone={run.passed > 0 ? 'good' : 'zero'}
          meterPct={stats.passedPct}
        />
        <StatCard
          label="Failed"
          value={run.failed}
          tone={run.failed > 0 ? 'bad' : 'zero'}
          meterPct={stats.failedPct}
        />
        <StatCard
          label="Errored"
          value={run.errored}
          tone={run.errored > 0 ? 'bad' : 'zero'}
        />
        <StatCard
          label="Cache %"
          value={run.prompt_tokens > 0 ? Math.round((run.cached_prompt_tokens / run.prompt_tokens) * 100) + '%' : '—'}
          tone={run.prompt_tokens === 0 ? 'zero' : 'default'}
        />
        <StatCard
          label="p95 TTFT"
          value={run.ttft_p95_ms != null ? formatMs(run.ttft_p95_ms) : '—'}
          tone={run.ttft_p95_ms == null ? 'zero' : 'default'}
        />
        <StatCard
          label="p95 TTFB"
          value={run.ttfb_p95_ms != null ? formatMs(run.ttfb_p95_ms) : '—'}
          tone={run.ttfb_p95_ms == null ? 'zero' : 'default'}
        />
        <StatCard
          label="Tool calls"
          value={stats.totalToolCalls > 0 ? stats.totalToolCalls : '—'}
          suffix={stats.avgToolCallsPerCase != null && stats.totalToolCalls > 0 ? `${stats.avgToolCallsPerCase} avg/case` : undefined}
          tone={stats.totalToolCalls > 0 ? 'default' : 'zero'}
        />
        <StatCard
          label="Tokens"
          value={formatTokens(run.total_tokens)}
          suffix={stats.avgTokensPerCase != null && run.total_tokens > 0 ? `${stats.avgTokensPerCase.toLocaleString()} avg/case` : undefined}
          tone={run.total_tokens > 0 ? 'default' : 'zero'}
        />
        <StatCard
          label="Est. cost"
          value={formatCost(run.estimated_cost_usd)}
          suffix={stats.avgCostPerCase != null ? `$${stats.avgCostPerCase.toFixed(4)}/case` : undefined}
          tone={run.estimated_cost_usd == null ? 'zero' : 'default'}
        />
      </div>

      {(percentilesData.length > 0 || overCasesData.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {percentilesData.length > 0 && (
            <ChartCard
              title="Latency Percentiles"
              legend={[
                { color: 'hsl(var(--primary) / 0.3)', label: 'Avg' },
                { color: 'hsl(var(--primary) / 0.6)', label: 'P50' },
                { color: 'hsl(var(--primary))', label: 'P95' },
              ]}
            >
              <BarChart data={percentilesData} barCategoryGap="20%">
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
                <Tooltip
                  formatter={(v: unknown) => formatMs(Number(v))}
                  contentStyle={{
                    background: 'hsl(var(--background))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 8,
                  }}
                />
                <Bar dataKey="avg" name="Avg" fill="hsl(var(--primary) / 0.3)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="p50" name="P50" fill="hsl(var(--primary) / 0.6)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="p95" name="P95" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartCard>
          )}

          {overCasesData.length > 0 && (
            <ChartCard
              title="Latency Over Cases"
              subtitle="Avg TTFT and TTFB across cases in order"
              legend={[
                { color: CHART_COLORS.ttft, label: 'TTFT' },
                { color: CHART_COLORS.ttfb, label: 'TTFB' },
              ]}
            >
              <LineChart data={overCasesData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--st1))" />
                <XAxis
                  dataKey="idx"
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                  stroke="hsl(var(--st2))"
                />
                <YAxis
                  tickFormatter={(v: number) => formatMs(v)}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                  stroke="hsl(var(--st2))"
                />
                <Tooltip
                  formatter={(v: unknown) => formatMs(Number(v))}
                  contentStyle={{
                    background: 'hsl(var(--background))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 8,
                  }}
                />
                <Line type="monotone" dataKey="ttft" name="TTFT" stroke={CHART_COLORS.ttft} dot={false} strokeWidth={2} connectNulls />
                <Line type="monotone" dataKey="ttfb" name="TTFB" stroke={CHART_COLORS.ttfb} dot={false} strokeWidth={2} connectNulls />
              </LineChart>
            </ChartCard>
          )}

        </div>
      )}

      {run.total_tokens > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-lg border bg-card p-5">
            <span className="text-p-400 font-medium">Token &amp; cost</span>
            <p className="text-xs text-muted-foreground mt-0.5">Prompt vs completion split</p>
            <div className="mt-3 flex items-center gap-6">
              <div className="relative h-32 w-32 shrink-0">
                <PieChart width={128} height={128}>
                  <Pie
                    data={[
                      { name: 'prompt', value: run.prompt_tokens },
                      { name: 'completion', value: run.completion_tokens },
                    ].filter((d) => d.value > 0)}
                    dataKey="value"
                    cx={64}
                    cy={64}
                    outerRadius={55}
                    innerRadius={32}
                    strokeWidth={0}
                  >
                    <Cell fill="hsl(var(--accent-purple))" />
                    <Cell fill="hsl(var(--success))" />
                  </Pie>
                </PieChart>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-xs-600 font-semibold tabular-nums">
                    {(run.total_tokens / 1000).toFixed(1)}k
                  </span>
                  <span className="text-[10px] text-muted-foreground">tokens</span>
                </div>
              </div>
              <div className="flex-1 space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <span className="inline-block h-2 w-2 rounded-sm bg-[hsl(var(--accent-purple))]" />
                    prompt
                  </span>
                  <span className="font-medium tabular-nums">{run.prompt_tokens.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <span className="inline-block h-2 w-2 rounded-sm bg-[hsl(var(--success))]" />
                    completion
                  </span>
                  <span className="tabular-nums">{run.completion_tokens.toLocaleString()}</span>
                </div>
                {run.estimated_cost_usd != null && (
                  <div className="flex justify-between pt-1 border-t">
                    <span className="text-muted-foreground">est. cost</span>
                    <span className="tabular-nums">{formatCost(run.estimated_cost_usd)}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {run.ci && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-4 py-3">
            <span className="text-xs-600 text-muted-foreground uppercase tracking-wider">CI</span>
            {run.ci.provider && (
              <span className="text-xs capitalize">{String(run.ci.provider)}</span>
            )}
            {run.ci.git_branch && (
              <span className="inline-flex items-center gap-1 text-xs">
                <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                {String(run.ci.git_branch)}
              </span>
            )}
            {run.ci.git_sha && (
              <span className="inline-flex items-center gap-1 text-xs font-mono">
                <GitCommit className="h-3.5 w-3.5 text-muted-foreground" />
                {String(run.ci.git_sha).slice(0, 7)}
              </span>
            )}
            {run.ci.run_url && (
              <a
                href={String(run.ci.run_url)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                View run <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {run.ci.commit_message && (
              <span className="text-xs text-muted-foreground italic truncate max-w-[40ch]">
                "{String(run.ci.commit_message)}"
              </span>
            )}
          </CardContent>
        </Card>
      )}

      <div>
        <div className="flex items-center justify-between mb-3 gap-3">
          <h2 className="text-h4-600 font-semibold">
            Cases{' '}
            <span className="text-muted-foreground text-xs">
              ({filteredCases.length} of {run.cases.length})
            </span>
          </h2>
          <div className="flex items-center gap-2">
            {selectedCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="text-[hsl(var(--destructive))] [&_svg]:text-current hover:[&_svg]:text-current border-[hsl(var(--destructive-border))] hover:bg-[hsl(var(--destructive-bg))]"
                onClick={() => setConfirmOpen(true)}
              >
                <Trash2 /> Delete
              </Button>
            )}
            <input
              type="text"
              placeholder="Search name…"
              value={caseSearch}
              onChange={(e) => setCaseSearch(e.target.value)}
              className="h-8 w-64 rounded-md border border-border bg-background px-3 text-xs outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>
        <div style={{ borderRadius: 10, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 12.5 }}>
            <thead>
              <tr>
                {['', 'Name', 'Status', 'Duration', 'TTFT', 'TTFB', 'Tokens', 'Cache', 'Cost', 'Tools', 'Judgments', 'Events'].map((h, i) => (
                  <th key={i} style={{
                    padding: '10px 14px', textAlign: 'left', fontWeight: 500,
                    color: 'hsl(var(--muted-foreground))', fontSize: 11,
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                    borderBottom: '1px solid hsl(var(--border))',
                    background: 'hsl(var(--card))', whiteSpace: 'nowrap',
                  }}>
                    {i === 0 ? (
                      <Checkbox
                        checked={allVisibleSelected}
                        onCheckedChange={(checked) => toggleAllVisibleSelected(checked === true)}
                        aria-label="Select all visible cases"
                      />
                    ) : h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredCases.map((c) => {
                const judgePass = c.judgments.filter((j) => j.verdict === 'pass').length
                const judgeFail = c.judgments.filter((j) => j.verdict === 'fail').length
                return (
                  <tr
                    key={c.case_id}
                    onClick={() => handleRowClick(c.case_id)}
                    style={{ cursor: 'pointer', transition: 'background 100ms ease' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'hsl(var(--muted))' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = '' }}
                  >
                    <td
                      style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={selectedSet.has(c.case_id)}
                        onCheckedChange={(checked) => toggleCaseSelected(c.case_id, checked === true)}
                        aria-label={`Select case ${c.name}`}
                      />
                    </td>
                    <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      {c.name}
                    </td>
                    <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))' }}>
                      <StatusChip status={c.status} />
                    </td>
                    <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                      {formatDuration(c.duration_ms)}
                    </td>
                    <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                      {c.ttft_avg_ms != null ? formatMs(c.ttft_avg_ms) : '—'}
                    </td>
                    <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                      {c.ttfb_avg_ms != null ? formatMs(c.ttfb_avg_ms) : '—'}
                    </td>
                    <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                      {formatTokens(c.total_tokens)}
                    </td>
                    <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--muted-foreground))' }}>
                      {c.prompt_tokens > 0 ? Math.round((c.cached_prompt_tokens / c.prompt_tokens) * 100) + '%' : '—'}
                    </td>
                    <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                      {formatCost(c.estimated_cost_usd)}
                    </td>
                    <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                      {c.tool_call_count ?? '—'}
                    </td>
                    <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontSize: 12 }}>
                      {c.judgments.length === 0 ? (
                        <span style={{ color: 'hsl(var(--muted-foreground))' }}>—</span>
                      ) : (
                        <span className="inline-flex items-center gap-2">
                          {judgePass > 0 && (
                            <span className="text-[hsl(var(--success-fg,var(--success)))] text-xs-600">
                              ✓ {judgePass} pass
                            </span>
                          )}
                          {judgePass > 0 && judgeFail > 0 && (
                            <span className="text-muted-foreground">·</span>
                          )}
                          {judgeFail > 0 && (
                            <Badge
                              variant="outline"
                              className="text-xxs-600 text-[hsl(var(--destructive))] border-[hsl(var(--destructive-border))] bg-[hsl(var(--destructive-bg))] uppercase tracking-wider"
                            >
                              {judgeFail} fail
                            </Badge>
                          )}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                      {c.events.length}
                    </td>
                  </tr>
                )
              })}
              {filteredCases.length === 0 && (
                <tr>
                  <td colSpan={12} style={{ padding: '24px 14px', textAlign: 'center', color: 'hsl(var(--muted-foreground))' }}>
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
            <DialogTitle>Delete {selectedCount} case{selectedCount === 1 ? '' : 's'}?</DialogTitle>
            <DialogDescription>
              This permanently removes the selected case{selectedCount === 1 ? '' : 's'} and every event and judgment captured under {selectedCount === 1 ? 'it' : 'them'}. This cannot be undone.
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
