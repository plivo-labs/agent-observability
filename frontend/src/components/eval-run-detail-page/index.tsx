import { useEffect, useMemo, useState } from 'react'
import { parseAsString, useQueryState } from 'nuqs'
import { Trash2 } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { useEvalRun } from '@/lib/observability-hooks'
import { useObservabilityContext } from '@/lib/observability-provider'
import { EvalCaseDetailPage } from '@/components/eval-case-detail-page'
import { AgentScopeHeader } from '@/components/agent-scope-header'

import {
  ASR_BAD,
  ASR_WARN,
  TTFB_BAD_MS,
  TTFT_BAD_MS,
  caseAsrConfidence,
  detectMetricsView,
  type EnrichedCase,
  type MetricsView,
  type OverCasesDatum,
  type RunStats,
  type StatusFilter,
} from './model'
import { FilterPill, RunMetaStrip } from './primitives'
import { KpiStrip } from './kpi-strip'
import {
  LatencyOverCasesChart,
  PipelineOrDurationChart,
  TokenCostPanel,
} from './charts'
import { CasesTable } from './cases-table'
import { DeleteCasesDialog } from './delete-cases-dialog'

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
        <div
          className="grid gap-2.5"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}
        >
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
