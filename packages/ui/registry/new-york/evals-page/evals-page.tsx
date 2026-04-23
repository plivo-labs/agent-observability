import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { Calendar as CalendarIcon, FlaskConical, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { formatDate, formatDuration } from '@/lib/observability-format'
import { useEvalRuns } from '@/lib/observability-hooks'

/** Build page numbers with ellipsis for large page counts. */
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

const startOfLocalDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
const endOfLocalDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)

function DatePickerField({
  value,
  onChange,
  placeholder,
}: {
  value: Date | undefined
  onChange: (date: Date | undefined) => void
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            'h-9 w-44 justify-start text-left font-normal text-s-400',
            !value && 'text-muted-foreground',
          )}
        >
          <CalendarIcon className="h-3.5 w-3.5 mr-2" />
          {value ? dayjs(value).format('MMM D, YYYY') : <span>{placeholder}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          onSelect={(d) => {
            onChange(d)
            if (d) setOpen(false)
          }}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  )
}

function PassRateBar({ passed, total }: { passed: number; total: number }) {
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0
  const tone =
    pct >= 95
      ? 'bg-[hsl(var(--success,162_94%_24%))]'
      : pct >= 70
        ? 'bg-[hsl(var(--warning,28_85%_36%))]'
        : 'bg-[hsl(var(--destructive))]'
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <span className="font-mono text-xs-600 tabular-nums w-10">{pct}%</span>
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden max-w-[90px]">
        <div className={cn('h-full', tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function FrameworkBadge({ name, version }: { name: string; version: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted border text-xs-500">
      <FlaskConical className="h-3 w-3 text-muted-foreground" />
      {name}
      {version && <span className="text-muted-foreground font-mono text-[11px]">{version}</span>}
    </span>
  )
}

const inputClass =
  'h-9 rounded-md border border-input bg-background px-3 py-1 text-s-400 shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

export const EvalsPage = ({ onRunClick }: { onRunClick?: (runId: string) => void }) => {
  const [accountInput, setAccountInput] = useState('')
  const [agentInput, setAgentInput] = useState('')
  const [startedOn, setStartedOn] = useState<Date | undefined>(undefined)
  const debouncedAccount = useDebounce(accountInput, 300)
  const debouncedAgent = useDebounce(agentInput, 300)

  const { runs, meta, loading, error, offset, setOffset } = useEvalRuns(20, 0, {
    accountId: debouncedAccount.trim() || undefined,
    agentId: debouncedAgent.trim() || undefined,
    startedFrom: startedOn ? startOfLocalDay(startedOn).toISOString() : undefined,
    startedTo: startedOn ? endOfLocalDay(startedOn).toISOString() : undefined,
  })

  const limit = meta.limit || 20
  const totalCount = meta.total_count
  const hasFilters = !!(accountInput || agentInput || startedOn)
  const clearFilters = () => {
    setAccountInput('')
    setAgentInput('')
    setStartedOn(undefined)
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
          <label className="text-xs-500 text-muted-foreground">Account ID</label>
          <input
            type="text"
            value={accountInput}
            onChange={(e) => setAccountInput(e.target.value)}
            placeholder="Filter by account"
            className={`${inputClass} w-56`}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs-500 text-muted-foreground">Started on</label>
          <DatePickerField
            value={startedOn}
            onChange={setStartedOn}
            placeholder="Pick a date"
          />
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters} className="h-9">
            <X className="h-3.5 w-3.5 mr-1" />
            Clear
          </Button>
        )}
      </div>

      {error ? (
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
                  <TableHead>Account</TableHead>
                  <TableHead>Pass rate</TableHead>
                  <TableHead>Cases</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Commit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && runs.length === 0 ? (
                  Array.from({ length: Math.min(limit, 8) }).map((_, i) => (
                    <TableRow key={`sk-${i}`} aria-hidden="true">
                      {Array.from({ length: 9 }).map((__, j) => (
                        <TableCell key={j}><Skeleton className="h-4 w-24" /></TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : runs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
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
                      <TableCell className="font-mono text-s-400">
                        {run.run_id.slice(0, 8)}
                      </TableCell>
                      <TableCell className="text-s-400">
                        {run.agent_id ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>
                        <FrameworkBadge name={run.framework} version={run.framework_version} />
                      </TableCell>
                      <TableCell className="font-mono text-s-400 text-muted-foreground max-w-[140px] truncate">
                        {run.account_id ?? '—'}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <PassRateBar passed={run.passed} total={run.total} />
                          {run.failed + run.errored > 0 && (
                            <Badge variant="outline" className="text-xxs-600 text-destructive border-[hsl(var(--destructive-border,0_93%_88%))]">
                              {run.failed + run.errored} fail
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-s-400 tabular-nums">{run.total}</TableCell>
                      <TableCell className="font-mono text-s-400 tabular-nums">
                        {formatDuration(run.duration_ms)}
                      </TableCell>
                      <TableCell className="text-s-400 text-muted-foreground whitespace-nowrap">
                        {formatDate(run.started_at)}
                      </TableCell>
                      <TableCell className="font-mono text-s-400 text-muted-foreground">
                        {run.ci?.git_sha ? String(run.ci.git_sha).slice(0, 7) : '—'}
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
