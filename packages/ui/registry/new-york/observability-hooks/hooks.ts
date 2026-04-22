import { useEffect, useMemo, useState } from 'react'
import { useObservabilityContext } from '@/lib/observability-provider'
import type {
  AgentSessionRow,
  ChatItem,
  MetricsSummary,
  PlivoMeta,
  SessionEvent,
  SessionMetrics,
  SessionsFilters,
  TurnRecord,
} from '@/lib/observability-types'

// ---------------------------------------------------------------------------
// useSessions — fetches paginated session list
// ---------------------------------------------------------------------------

export function useSessions(
  limit = 20,
  initialOffset = 0,
  filters?: SessionsFilters,
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

  const accountId = filters?.accountId
  const startedFrom = filters?.startedFrom
  const startedTo = filters?.startedTo

  // Sync offset when the caller passes a live initialOffset (e.g. from URL
  // state). Callers who drive pagination via setOffset pass a stable 0 and
  // this no-ops after mount.
  useEffect(() => {
    setOffset(initialOffset)
  }, [initialOffset])

  useEffect(() => {
    setOffset(0)
  }, [accountId, startedFrom, startedTo])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .listSessions(limit, offset, { accountId, startedFrom, startedTo })
      .then((res) => {
        if (cancelled) return
        setSessions(res.objects)
        setMeta(res.meta)
      })
      .catch((e) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, limit, offset, accountId, startedFrom, startedTo])

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

// ---------------------------------------------------------------------------
// useEvents / useOptions — raw session report slices
// ---------------------------------------------------------------------------

export function useEvents(): SessionEvent[] | null {
  const { session } = useObservabilityContext()
  return session?.events ?? null
}

export function useOptions(): Record<string, unknown> | null {
  const { session } = useObservabilityContext()
  return session?.options ?? null
}
