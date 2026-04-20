import { Badge } from '@/components/ui/badge'
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
import { useSessions } from '@/lib/observability-hooks'

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

const stateVariant = (state: string) => {
  switch (state) {
    case 'active':
      return 'default' as const
    case 'ended':
      return 'secondary' as const
    default:
      return 'outline' as const
  }
}

export const SessionsPage = ({ onSessionClick }: { onSessionClick?: (sessionId: string) => void }) => {
  const { sessions, meta, loading, error, offset, setOffset } = useSessions()
  const limit = meta.limit || 20
  const totalCount = meta.total_count

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          <span className="text-s-400">Loading sessions...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-12 text-center text-destructive">
        <p>Failed to load sessions: {error}</p>
      </div>
    )
  }

  const totalPages = Math.ceil(totalCount / limit)
  const currentPage = Math.floor(offset / limit) + 1

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-h2-600 font-semibold">Sessions</h1>
        <span className="text-s-400 text-muted-foreground">{totalCount} total</span>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Session ID</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Turns</TableHead>
              <TableHead>Capabilities</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
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
                    <Badge variant={stateVariant(session.state)}>{session.state}</Badge>
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
                  <TableCell className="text-s-400 text-muted-foreground">
                    {formatDate(session.created_at)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalCount > 0 && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-s-400 text-muted-foreground">
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
    </div>
  )
}
