import { useEffect, useMemo, useState } from 'react'
import { useObservabilityContext } from '@/lib/observability-provider'
import type {
  AgentSessionRow,
  ChatItem,
  EvalCaseRow,
  EvalRunDetail,
  EvalRunRow,
  EvalsFilters,
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
  const transport = filters?.transport
  const transportKey = (transport ?? []).slice().sort().join(',')

  useEffect(() => {
    setOffset(0)
  }, [accountId, startedFrom, startedTo, transportKey])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .listSessions(limit, offset, { accountId, startedFrom, startedTo, transport })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, limit, offset, accountId, startedFrom, startedTo, transportKey])

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

// ---------------------------------------------------------------------------
// useEvalRuns / useEvalRun / useEvalCase
// ---------------------------------------------------------------------------

export function useEvalRuns(
  limit = 20,
  initialOffset = 0,
  filters?: EvalsFilters,
) {
  const { api } = useObservabilityContext()
  const [runs, setRuns] = useState<EvalRunRow[]>([])
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

  const { agentId, framework, accountId, startedFrom, startedTo } = filters ?? {}
  // Stable string key for the framework array so effect deps don't churn
  // on new-but-equal-array identities every render.
  const frameworkKey = (framework ?? []).slice().sort().join(',')

  useEffect(() => {
    setOffset(0)
  }, [agentId, frameworkKey, accountId, startedFrom, startedTo])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .listEvalRuns(limit, offset, {
        agentId,
        framework: framework && framework.length ? framework : undefined,
        accountId,
        startedFrom,
        startedTo,
      })
      .then((res) => {
        if (cancelled) return
        setRuns(res.objects)
        setMeta(res.meta)
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, limit, offset, agentId, frameworkKey, accountId, startedFrom, startedTo])

  return { runs, meta, loading, error, offset, setOffset }
}

export function useEvalRun(runId: string | undefined) {
  const { api } = useObservabilityContext()
  const [run, setRun] = useState<EvalRunDetail | null>(null)
  const [loading, setLoading] = useState(!!runId)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!runId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .getEvalRun(runId)
      .then((res) => !cancelled && setRun(res))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [api, runId])

  return { run, loading, error }
}

export function useEvalCase(runId: string | undefined, caseId: string | undefined) {
  const { api } = useObservabilityContext()
  const [evalCase, setEvalCase] = useState<EvalCaseRow | null>(null)
  const [loading, setLoading] = useState(!!(runId && caseId))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!runId || !caseId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .getEvalCase(runId, caseId)
      .then((res) => !cancelled && setEvalCase(res))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [api, runId, caseId])

  return { evalCase, loading, error }
}
