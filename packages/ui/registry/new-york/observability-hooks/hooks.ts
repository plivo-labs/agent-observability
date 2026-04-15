import { useEffect, useMemo, useState } from 'react'
import { useObservabilityContext } from '@/lib/observability-provider'
import type {
  AgentSessionRow,
  ChatItem,
  MetricsSummary,
  PlivoMeta,
  SessionMetrics,
  TurnRecord,
} from '@/lib/observability-types'

// ---------------------------------------------------------------------------
// useSessions — fetches paginated session list
// ---------------------------------------------------------------------------

export function useSessions(
  limit = 20,
  initialOffset = 0,
  accountId?: string,
) {
  const { api } = useObservabilityContext()
  const [sessions, setSessions] = useState<AgentSessionRow[]>([])
  const [meta, setMeta] = useState<PlivoMeta>({
    limit,
    offset: initialOffset,
    total_count: 0,
    next: null,
    previous: null,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [offset, setOffset] = useState(initialOffset)

  useEffect(() => {
    setLoading(true)
    setError(null)
    api
      .listSessions(limit, offset, accountId)
      .then((res) => {
        setSessions(res.objects)
        setMeta(res.meta)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [api, limit, offset, accountId])

  return { sessions, meta, loading, error, offset, setOffset }
}

// ---------------------------------------------------------------------------
// useSession — returns the current session from provider context
// ---------------------------------------------------------------------------

export function useSession() {
  const { session, sessionLoading, sessionError } = useObservabilityContext()
  return {
    session,
    loading: sessionLoading,
    error: sessionError,
  }
}

// ---------------------------------------------------------------------------
// useTimeline — derives timeline data from current session
// ---------------------------------------------------------------------------

export function useTimeline() {
  const { session, highlightedTurn, setHighlightedTurn } =
    useObservabilityContext()

  const metrics: SessionMetrics | null = session?.session_metrics ?? null
  const recordUrl: string | null = session?.record_url ?? null
  const sessionCreatedAt: string | undefined = session?.created_at

  return { metrics, recordUrl, sessionCreatedAt, highlightedTurn, setHighlightedTurn }
}

// ---------------------------------------------------------------------------
// useTranscript — derives transcript data from current session
// ---------------------------------------------------------------------------

export function useTranscript() {
  const { session, highlightedTurn, setHighlightedTurn } =
    useObservabilityContext()

  const metrics: SessionMetrics | null = session?.session_metrics ?? null
  const turns: TurnRecord[] = useMemo(
    () => metrics?.turns ?? [],
    [metrics],
  )
  const chatHistory: ChatItem[] | null = session?.chat_history ?? null

  return { turns, chatHistory, metrics, highlightedTurn, setHighlightedTurn }
}

// ---------------------------------------------------------------------------
// usePerformance — derives performance metrics from current session
// ---------------------------------------------------------------------------

export function usePerformance() {
  const { session } = useObservabilityContext()

  const metrics: SessionMetrics | null = session?.session_metrics ?? null
  const summary: MetricsSummary | null = metrics?.summary ?? null

  return { metrics, summary }
}
