import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { AudioLines, Calendar as CalendarIcon, Phone, X } from 'lucide-react'
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
import { useSessions } from '@/lib/observability-hooks'
import type { Transport } from '@/lib/observability-types'

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
  disabled,
}: {
  value: Date | undefined
  onChange: (date: Date | undefined) => void
  placeholder: string
  disabled?: (date: Date) => boolean
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
          disabled={disabled}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  )
}

const TransportCell = ({ transport }: { transport: Transport | null }) => {
  if (transport === 'sip') {
    return (
      <span className="inline-flex items-center gap-1.5 text-s-400">
        <Phone className="h-3.5 w-3.5 text-muted-foreground" />
        SIP
      </span>
    )
  }
  if (transport === 'audio_stream') {
    return (
      <span className="inline-flex items-center gap-1.5 text-s-400">
        <AudioLines className="h-3.5 w-3.5 text-muted-foreground" />
        Audio Stream
      </span>
    )
  }
  return <span className="text-muted-foreground">—</span>
}

const inputClass =
  'h-9 rounded-md border border-input bg-background px-3 py-1 text-s-400 shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

export const SessionsPage = ({ onSessionClick }: { onSessionClick?: (sessionId: string) => void }) => {
  const [accountInput, setAccountInput] = useState('')
  const [startedOn, setStartedOn] = useState<Date | undefined>(undefined)
  const debouncedAccount = useDebounce(accountInput, 300)

  const { sessions, meta, loading, error, offset, setOffset } = useSessions(20, 0, {
    accountId: debouncedAccount.trim() || undefined,
    startedFrom: startedOn ? startOfLocalDay(startedOn).toISOString() : undefined,
    startedTo: startedOn ? endOfLocalDay(startedOn).toISOString() : undefined,
  })

  const limit = meta.limit || 20
  const totalCount = meta.total_count
  const hasFilters = !!(accountInput || startedOn)
  const clearFilters = () => {
    setAccountInput('')
    setStartedOn(undefined)
  }

  const totalPages = Math.ceil(totalCount / limit)
  const currentPage = Math.floor(offset / limit) + 1

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-h2-600 font-semibold">Sessions</h1>
        <span className="text-s-400 text-muted-foreground">{totalCount} total</span>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-4">
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
          <p>Failed to load sessions: {error}</p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session ID</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Transport</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Ended</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Turns</TableHead>
                  <TableHead>Capabilities</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && sessions.length === 0 ? (
                  Array.from({ length: Math.min(limit, 8) }).map((_, i) => (
                    <TableRow key={`sk-${i}`} aria-hidden="true">
                      {Array.from({ length: 8 }).map((__, j) => (
                        <TableCell key={j}><Skeleton className="h-4 w-24" /></TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : sessions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      No sessions found
                    </TableCell>
                  </TableRow>
                ) : (
                  sessions.map((session) => (
                    <TableRow
                      key={session.id}
                      className="cursor-pointer hover:bg-accent/50"
                      onClick={() => onSessionClick?.(session.session_id)}
                    >
                      <TableCell className="font-mono text-s-400 max-w-[200px] truncate">
                        {session.session_id}
                      </TableCell>
                      <TableCell className="font-mono text-s-400 max-w-[150px] truncate text-muted-foreground">
                        {session.account_id ?? '—'}
                      </TableCell>
                      <TableCell>
                        <TransportCell transport={session.transport} />
                      </TableCell>
                      <TableCell className="text-s-400 text-muted-foreground whitespace-nowrap">
                        {formatDate(session.started_at)}
                      </TableCell>
                      <TableCell className="text-s-400 text-muted-foreground whitespace-nowrap">
                        {formatDate(session.ended_at)}
                      </TableCell>
                      <TableCell className="text-s-400">
                        {formatDuration(session.duration_ms)}
                      </TableCell>
                      <TableCell className="text-s-400">{session.turn_count}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {session.has_stt && <Badge variant="outline" className="text-xxs-400">STT</Badge>}
                          {session.has_llm && <Badge variant="outline" className="text-xxs-400">LLM</Badge>}
                          {session.has_tts && <Badge variant="outline" className="text-xxs-400">TTS</Badge>}
                        </div>
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
