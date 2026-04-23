import { useMemo, useState } from 'react'
import { ArrowLeft, ExternalLink, FlaskConical, GitBranch, GitCommit } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useEvalRun } from '@/lib/observability-hooks'
import type { CaseStatus, EvalCaseRow } from '@/lib/observability-types'
import { EvalCaseDetailPage } from '@/components/eval-case-detail-page'

const STATUS_TONE: Record<CaseStatus, string> = {
  passed:
    'bg-[hsl(var(--success-bg,142_76%_96%))] text-[hsl(var(--success,162_94%_24%))] border-[hsl(var(--success-border,156_72%_80%))]',
  failed:
    'bg-[hsl(var(--destructive-bg,0_85%_97%))] text-destructive border-[hsl(var(--destructive-border,0_93%_88%))]',
  errored:
    'bg-[hsl(var(--warning-bg,48_100%_96%))] text-[hsl(var(--warning,28_85%_36%))] border-[hsl(var(--warning-border,45_96%_75%))]',
  skipped: 'bg-muted text-muted-foreground border',
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

function StatCard({
  label,
  value,
  suffix,
  tone = 'default',
  meterPct,
  meterClass,
}: {
  label: string
  value: string | number
  suffix?: string
  tone?: 'default' | 'hero' | 'passed' | 'failed' | 'zero'
  meterPct?: number
  meterClass?: string
}) {
  const valueTone =
    tone === 'hero' || tone === 'failed'
      ? 'text-destructive'
      : tone === 'passed'
        ? 'text-[hsl(var(--success,162_94%_24%))]'
        : tone === 'zero'
          ? 'text-muted-foreground'
          : ''
  const cardTone =
    tone === 'hero'
      ? 'bg-gradient-to-b from-[hsl(var(--destructive-bg,0_85%_97%))] to-card border-[hsl(var(--destructive-border,0_93%_88%))]'
      : ''
  return (
    <Card className={cn('relative overflow-hidden', cardTone)}>
      <CardHeader className="pb-2">
        <CardTitle className={cn('text-xs-600 uppercase tracking-wide text-muted-foreground', tone === 'hero' && 'text-destructive')}>
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn('text-h1-600 font-semibold tabular-nums flex items-baseline gap-2', valueTone)}>
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

export const EvalRunDetailPage = ({
  runId,
  onBack,
  onCaseClick,
}: {
  runId: string
  onBack?: () => void
  onCaseClick?: (caseId: string) => void
}) => {
  const { run, loading, error } = useEvalRun(runId)
  const [openCaseId, setOpenCaseId] = useState<string | null>(null)

  const handleRowClick = (caseId: string) => {
    if (onCaseClick) onCaseClick(caseId)
    else setOpenCaseId(caseId)
  }

  const stats = useMemo(() => {
    if (!run) return null
    const passRate = run.total > 0 ? Math.round((run.passed / run.total) * 100) : 0
    return {
      passRate,
      hasAnyFailure: run.failed > 0 || run.errored > 0,
      passedPct: run.total > 0 ? (run.passed / run.total) * 100 : 0,
      failedPct: run.total > 0 ? (run.failed / run.total) * 100 : 0,
    }
  }, [run])

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
      <div className="p-12 text-center text-destructive">
        <p>Failed to load eval run: {error ?? 'not found'}</p>
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="mt-4">
            <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="p-6 flex flex-col gap-5 relative">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-s-500 text-muted-foreground hover:text-foreground transition-colors bg-transparent border-none p-0 w-fit cursor-pointer"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to evals
        </button>
      )}

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <h1 className="text-h2-600 font-semibold m-0">
              {run.agent_id ?? <span className="text-muted-foreground">—</span>}
            </h1>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted border text-xs-500">
              <FlaskConical className="h-3 w-3 text-muted-foreground" />
              {run.framework}
              {run.framework_version && (
                <span className="text-muted-foreground font-mono text-[11px]">
                  {run.framework_version}
                </span>
              )}
            </span>
          </div>
          <div className="font-mono text-xs-400 text-muted-foreground">{run.run_id}</div>
        </div>
        <div className="text-right text-s-400 text-muted-foreground">
          <b className="block text-foreground text-s-600">
            Started {formatDate(run.started_at)}
          </b>
          <span>Duration {formatDuration(run.duration_ms)}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard
          label="Pass rate"
          value={stats.passRate}
          suffix="%"
          tone={stats.hasAnyFailure ? 'hero' : 'passed'}
          meterPct={stats.passRate}
          meterClass={
            stats.passRate === 100
              ? 'bg-[hsl(var(--success,162_94%_24%))]'
              : 'bg-destructive'
          }
        />
        <StatCard
          label="Passed"
          value={run.passed}
          tone="passed"
          meterPct={stats.passedPct}
          meterClass="bg-[hsl(var(--success,162_94%_24%))]"
        />
        <StatCard
          label="Failed"
          value={run.failed}
          tone={run.failed > 0 ? 'failed' : 'zero'}
          meterPct={stats.failedPct}
          meterClass="bg-destructive"
        />
        <StatCard
          label="Errored"
          value={run.errored}
          tone={run.errored > 0 ? 'failed' : 'zero'}
        />
        <StatCard label="Skipped" value={run.skipped} tone="zero" />
      </div>

      {run.ci && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-4 py-3">
            <span className="text-xs-600 text-muted-foreground uppercase tracking-wider">CI</span>
            {run.ci.provider && (
              <span className="text-s-400 capitalize">{String(run.ci.provider)}</span>
            )}
            {run.ci.git_branch && (
              <span className="inline-flex items-center gap-1 text-s-400">
                <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                {String(run.ci.git_branch)}
              </span>
            )}
            {run.ci.git_sha && (
              <span className="inline-flex items-center gap-1 text-s-400 font-mono">
                <GitCommit className="h-3.5 w-3.5 text-muted-foreground" />
                {String(run.ci.git_sha).slice(0, 7)}
              </span>
            )}
            {run.ci.run_url && (
              <a
                href={String(run.ci.run_url)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-s-400 text-primary hover:underline"
              >
                View run <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {run.ci.commit_message && (
              <span className="text-s-400 text-muted-foreground italic truncate max-w-[40ch]">
                "{String(run.ci.commit_message)}"
              </span>
            )}
          </CardContent>
        </Card>
      )}

      <div>
        <h2 className="text-h4-600 font-semibold mb-3">
          Cases{' '}
          <span className="text-muted-foreground text-s-400">({run.cases.length})</span>
        </h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>File</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Judgments</TableHead>
                <TableHead>Events</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.cases.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    No cases in this run.
                  </TableCell>
                </TableRow>
              ) : (
                run.cases.map((c: EvalCaseRow) => {
                  const judgePass = c.judgments.filter((j) => j.verdict === 'pass').length
                  const judgeFail = c.judgments.filter((j) => j.verdict === 'fail').length
                  return (
                    <TableRow
                      key={c.case_id}
                      className="cursor-pointer hover:bg-accent/50"
                      onClick={() => handleRowClick(c.case_id)}
                    >
                      <TableCell className="font-mono text-s-400">{c.name}</TableCell>
                      <TableCell className="font-mono text-xs-400 text-muted-foreground">
                        {c.file ?? '—'}
                      </TableCell>
                      <TableCell>
                        <StatusChip status={c.status} />
                      </TableCell>
                      <TableCell className="font-mono text-s-400 tabular-nums">
                        {formatDuration(c.duration_ms)}
                      </TableCell>
                      <TableCell className="text-s-400">
                        {c.judgments.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span className="inline-flex items-center gap-2">
                            {judgePass > 0 && (
                              <span className="text-[hsl(var(--success,162_94%_24%))] text-xs-600">
                                ✓ {judgePass} pass
                              </span>
                            )}
                            {judgePass > 0 && judgeFail > 0 && (
                              <span className="text-muted-foreground">·</span>
                            )}
                            {judgeFail > 0 && (
                              <Badge variant="outline" className="text-xxs-600 text-destructive border-[hsl(var(--destructive-border,0_93%_88%))]">
                                {judgeFail} fail
                              </Badge>
                            )}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-s-400 tabular-nums text-muted-foreground">
                        {c.events.length}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {!onCaseClick && (
        <Sheet
          open={!!openCaseId}
          onOpenChange={(open) => {
            if (!open) setOpenCaseId(null)
          }}
        >
          <SheetContent
            className="w-full sm:max-w-2xl md:max-w-3xl overflow-y-auto p-0"
            showCloseButton={false}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Case detail</SheetTitle>
            </SheetHeader>
            {openCaseId && (
              <EvalCaseDetailPage
                runId={runId}
                caseId={openCaseId}
                onBack={() => setOpenCaseId(null)}
              />
            )}
          </SheetContent>
        </Sheet>
      )}
    </div>
  )
}
