import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
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
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useEvalRuns } from '@/lib/observability-hooks'
import type { EvalRunRow } from '@/lib/observability-types'

function getPageNumbers(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages: (number | 'ellipsis')[] = [1]
  if (current > 3) pages.push('ellipsis')
  const start = Math.max(2, current - 1)
  const end = Math.min(total - 1, current + 1)
  for (let i = start; i <= end; i++) pages.push(i)
  if (current < total - 2) pages.push('ellipsis')
  pages.push(total)
  return pages
}

function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

const inputClass =
  'h-9 rounded-md border border-input bg-background px-3 py-1 text-s-400 shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

function PassRateCell({ run }: { run: EvalRunRow }) {
  const { total, passed, failed, errored, skipped } = run
  const rate = total > 0 ? Math.round((passed / total) * 100) : 0
  const anyFailed = failed > 0 || errored > 0
  return (
    <div className="flex items-center gap-2">
      <span
        className={
          anyFailed
            ? 'text-destructive font-medium'
            : rate === 100
              ? 'text-emerald-600 dark:text-emerald-400 font-medium'
              : 'text-s-400'
        }
      >
        {rate}%
      </span>
      <span className="text-xs-400 text-muted-foreground whitespace-nowrap">
        {passed}/{total}
        {failed > 0 && (
          <span className="text-destructive ml-1">· {failed} failed</span>
        )}
        {errored > 0 && (
          <span className="text-destructive ml-1">· {errored} errored</span>
        )}
        {skipped > 0 && (
          <span className="ml-1">· {skipped} skipped</span>
        )}
      </span>
    </div>
  )
}

export const EvalsPage = ({ onRunClick }: { onRunClick?: (runId: string) => void }) => {
  const [agentInput, setAgentInput] = useState('')
  const [frameworkInput, setFrameworkInput] = useState('')
  const [accountInput, setAccountInput] = useState('')
  const debouncedAgent = useDebounce(agentInput, 300)
  const debouncedFramework = useDebounce(frameworkInput, 300)
  const debouncedAccount = useDebounce(accountInput, 300)

  const { runs, meta, loading, error, offset, setOffset } = useEvalRuns(20, 0, {
    agentId: debouncedAgent.trim() || undefined,
    framework: debouncedFramework.trim() || undefined,
    accountId: debouncedAccount.trim() || undefined,
  })

  const limit = meta.limit || 20
  const totalCount = meta.total_count
  const hasFilters = !!(agentInput || frameworkInput || accountInput)
  const clearFilters = () => {
    setAgentInput('')
    setFrameworkInput('')
    setAccountInput('')
  }

  const totalPages = Math.ceil(totalCount / limit)
  const currentPage = Math.floor(offset / limit) + 1

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-h2-600 font-semibold">Evals</h1>
        <span className="text-s-400 text-muted-foreground">{totalCount} total</span>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs-500 text-muted-foreground">Agent ID</label>
          <input
            type="text"
            value={agentInput}
            onChange={(e) => setAgentInput(e.target.value)}
            placeholder="Filter by agent"
            className={`${inputClass} w-56`}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs-500 text-muted-foreground">Framework</label>
          <input
            type="text"
            value={frameworkInput}
            onChange={(e) => setFrameworkInput(e.target.value)}
            placeholder="pytest / vitest"
            className={`${inputClass} w-40`}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs-500 text-muted-foreground">Account ID</label>
          <input
            type="text"
            value={accountInput}
            onChange={(e) => setAccountInput(e.target.value)}
            placeholder="Filter by account"
            className={`${inputClass} w-56`}
          />
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters} className="h-9">
            <X className="h-3.5 w-3.5 mr-1" />
            Clear
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center p-12 text-muted-foreground">
          <div className="flex flex-col items-center gap-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            <span className="text-s-400">Loading eval runs...</span>
          </div>
        </div>
      ) : error ? (
        <div className="p-12 text-center text-destructive">
          <p>Failed to load eval runs: {error}</p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Framework</TableHead>
                  <TableHead>Pass rate</TableHead>
                  <TableHead>Cases</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Commit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      No eval runs found
                    </TableCell>
                  </TableRow>
                ) : (
                  runs.map((run) => (
                    <TableRow
                      key={run.run_id}
                      className="cursor-pointer hover:bg-accent/50"
                      onClick={() => onRunClick?.(run.run_id)}
                    >
                      <TableCell className="font-mono text-s-400 max-w-[140px] truncate">
                        {run.run_id.slice(0, 8)}
                      </TableCell>
                      <TableCell className="text-s-400 max-w-[200px] truncate">
                        {run.agent_id ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-s-400">
                        <Badge variant="outline" className="text-xxs-400">
                          {run.framework}
                          {run.framework_version && (
                            <span className="ml-1 text-muted-foreground">
                              {run.framework_version}
                            </span>
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell><PassRateCell run={run} /></TableCell>
                      <TableCell className="text-s-400">{run.total}</TableCell>
                      <TableCell className="text-s-400">{formatDuration(run.duration_ms)}</TableCell>
                      <TableCell className="text-s-400 text-muted-foreground whitespace-nowrap">
                        {formatDate(run.started_at)}
                      </TableCell>
                      <TableCell className="font-mono text-xs-400 text-muted-foreground">
                        {run.ci?.git_sha ? run.ci.git_sha.slice(0, 7) : '—'}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {totalCount > 0 && (
            <div className="flex items-center justify-between mt-4">
              <span className="text-xs-400 text-muted-foreground whitespace-nowrap">
                Showing {offset + 1}–{Math.min(offset + limit, totalCount)} of {totalCount}
              </span>
              {totalPages > 1 && (
                <Pagination>
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        onClick={(e) => { e.preventDefault(); setOffset(Math.max(0, offset - limit)) }}
                        className={offset <= 0 ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                      />
                    </PaginationItem>
                    {getPageNumbers(currentPage, totalPages).map((p, i) =>
                      p === 'ellipsis' ? (
                        <PaginationItem key={`e-${i}`}>
                          <PaginationEllipsis />
                        </PaginationItem>
                      ) : (
                        <PaginationItem key={p}>
                          <PaginationLink
                            isActive={p === currentPage}
                            onClick={(e) => { e.preventDefault(); setOffset((p as number - 1) * limit) }}
                            className="cursor-pointer"
                          >
                            {p}
                          </PaginationLink>
                        </PaginationItem>
                      )
                    )}
                    <PaginationItem>
                      <PaginationNext
                        onClick={(e) => { e.preventDefault(); setOffset(offset + limit) }}
                        className={offset + limit >= totalCount ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                      />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
