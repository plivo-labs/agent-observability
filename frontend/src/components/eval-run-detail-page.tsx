import { ArrowLeft, ExternalLink, GitBranch, GitCommit } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CaseStatusBadge } from '@/components/eval-status-badge'
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useEvalRun } from '@/lib/observability-hooks'
import { useState, useMemo } from 'react'
import type { CaseStatus } from '@/lib/observability-types'

function SummaryCard({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string | number
  tone?: 'default' | 'good' | 'bad' | 'warn'
}) {
  const toneCls = {
    default: 'text-foreground',
    good: 'text-emerald-600 dark:text-emerald-400',
    bad: 'text-destructive',
    warn: 'text-amber-600 dark:text-amber-400',
  }[tone]
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-xs-500 text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={`mt-1 text-h3-600 font-semibold ${toneCls}`}>{value}</div>
    </div>
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
  const [statusFilter, setStatusFilter] = useState<CaseStatus | 'all'>('all')

  const filteredCases = useMemo(() => {
    if (!run) return []
    if (statusFilter === 'all') return run.cases
    return run.cases.filter((c) => c.status === statusFilter)
  }, [run, statusFilter])

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          <span className="text-s-400">Loading eval run...</span>
        </div>
      </div>
    )
  }

  if (error || !run) {
    return (
      <div className="p-12 text-center text-destructive">
        <p>Failed to load eval run: {error ?? 'not found'}</p>
        {onBack && (
          <Button variant="outline" onClick={onBack} className="mt-4">
            <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back
          </Button>
        )}
      </div>
    )
  }

  const passRate = run.total > 0 ? Math.round((run.passed / run.total) * 100) : 0

  return (
    <div className="p-6">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-4 inline-flex items-center gap-1 text-s-400 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to evals
        </button>
      )}

      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <div>
          <h1 className="text-h2-600 font-semibold flex items-center gap-2">
            {run.agent_id ?? <span className="text-muted-foreground">—</span>}
            <Badge variant="outline" className="text-xxs-400">
              {run.framework}
              {run.framework_version && (
                <span className="ml-1 text-muted-foreground">{run.framework_version}</span>
              )}
            </Badge>
          </h1>
          <div className="text-s-400 text-muted-foreground font-mono mt-1">{run.run_id}</div>
        </div>
        <div className="text-right text-s-400 text-muted-foreground">
          <div>Started {formatDate(run.started_at)}</div>
          <div>Duration {formatDuration(run.duration_ms)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-6">
        <SummaryCard label="Pass rate" value={`${passRate}%`} tone={passRate === 100 ? 'good' : 'bad'} />
        <SummaryCard label="Passed" value={run.passed} tone="good" />
        <SummaryCard label="Failed" value={run.failed} tone={run.failed > 0 ? 'bad' : 'default'} />
        <SummaryCard label="Errored" value={run.errored} tone={run.errored > 0 ? 'warn' : 'default'} />
        <SummaryCard label="Skipped" value={run.skipped} />
      </div>

      {run.ci && (
        <div className="mt-6 rounded-lg border bg-card p-4 flex flex-wrap items-center gap-4">
          <span className="text-xs-500 text-muted-foreground uppercase tracking-wide">CI</span>
          {run.ci.provider && (
            <span className="text-s-400 capitalize">{run.ci.provider}</span>
          )}
          {run.ci.git_branch && (
            <span className="inline-flex items-center gap-1 text-s-400">
              <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
              {run.ci.git_branch}
            </span>
          )}
          {run.ci.git_sha && (
            <span className="inline-flex items-center gap-1 text-s-400 font-mono">
              <GitCommit className="h-3.5 w-3.5 text-muted-foreground" />
              {run.ci.git_sha.slice(0, 7)}
            </span>
          )}
          {run.ci.run_url && (
            <a
              href={run.ci.run_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-s-400 text-primary hover:underline"
            >
              View run <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {run.ci.commit_message && (
            <span className="text-s-400 text-muted-foreground italic truncate max-w-[40ch]">
              "{run.ci.commit_message}"
            </span>
          )}
        </div>
      )}

      <div className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-h4-600 font-semibold">Cases ({filteredCases.length})</h2>
          <div className="flex gap-1">
            {(['all', 'passed', 'failed', 'errored', 'skipped'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`rounded-md border px-2.5 py-1 text-xs-500 transition-colors ${
                  statusFilter === s
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/40'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

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
              {filteredCases.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    No cases match the current filter.
                  </TableCell>
                </TableRow>
              ) : (
                filteredCases.map((c) => {
                  const judgePass = c.judgments.filter((j) => j.verdict === 'pass').length
                  const judgeFail = c.judgments.filter((j) => j.verdict === 'fail').length
                  return (
                    <TableRow
                      key={c.case_id}
                      className="cursor-pointer hover:bg-accent/50"
                      onClick={() => onCaseClick?.(c.case_id)}
                    >
                      <TableCell className="font-mono text-s-400">{c.name}</TableCell>
                      <TableCell className="text-s-400 text-muted-foreground max-w-[240px] truncate">
                        {c.file ?? '—'}
                      </TableCell>
                      <TableCell><CaseStatusBadge status={c.status} /></TableCell>
                      <TableCell className="text-s-400">{formatDuration(c.duration_ms)}</TableCell>
                      <TableCell className="text-s-400">
                        {c.judgments.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <>
                            {judgePass > 0 && (
                              <span className="text-emerald-600 dark:text-emerald-400">{judgePass} pass</span>
                            )}
                            {judgePass > 0 && judgeFail > 0 && <span> · </span>}
                            {judgeFail > 0 && (
                              <span className="text-destructive">{judgeFail} fail</span>
                            )}
                          </>
                        )}
                      </TableCell>
                      <TableCell className="text-s-400 text-muted-foreground">
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
    </div>
  )
}
