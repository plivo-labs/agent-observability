import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api } from '@/lib/api'
import { formatDate, formatDuration } from '@/lib/format'
import type { AgentSessionRow } from '@/lib/types'

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

export const SessionsPage = () => {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<AgentSessionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const limit = 50

  useEffect(() => {
    setLoading(true)
    api.listSessions(page, limit)
      .then((res) => {
        setSessions(res.data)
        setTotal(res.total)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [page])

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

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-h2-600 font-semibold">Sessions</h1>
        <span className="text-s-400 text-muted-foreground">{total} total</span>
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
                  onClick={() => navigate(`/sessions/${session.session_id}`)}
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

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <button
            className="px-3 py-1 rounded border text-s-400 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-accent"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span className="text-s-400 text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <button
            className="px-3 py-1 rounded border text-s-400 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-accent"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
