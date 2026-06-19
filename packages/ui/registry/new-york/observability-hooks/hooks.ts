import { useEffect, useMemo, useState } from 'react'
import { useObservabilityContext } from '@/lib/observability-provider'
import { sortEventsByCreatedAt } from '@/lib/observability-events'
import type {
  AgentRow,
  AgentSessionRow,
  AgentStats,
  AgentStatsRange,
  AgentsFilters,
  ChatItem,
  ConversationEvalSummary,
  GoalResultsSummary,
  GoalSessionResult,
  EvalCaseRow,
  EvalRunDetail,
  EvalRunRow,
  EvalsFilters,
  FleetStats,
  MetricsSummary,
  PlivoMeta,
  SessionExternalEvaluation,
  SessionEvent,
  SessionMetrics,
  SessionOutcome,
  SessionTag,
  SessionsFilters,
  TurnRecord,
} from '@/lib/observability-types'

// ---------------------------------------------------------------------------
// useSessions — fetches paginated session list
// ---------------------------------------------------------------------------

export function useSessions(
  limit = 20,
  offset = 0,
  filters?: SessionsFilters,
) {
  const { api } = useObservabilityContext()
  const [sessions, setSessions] = useState<AgentSessionRow[]>([])
  const [meta, setMeta] = useState<PlivoMeta>({
    limit,
    offset,
    total_count: 0,
    next: null,
    previous: null,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Bumping this re-runs the fetch effect — used by callers to refresh
  // after a mutation like bulk delete.
  const [refetchTick, setRefetchTick] = useState(0)
  const refetch = useMemo(() => () => setRefetchTick((v) => v + 1), [])

  const q = filters?.q
  const accountId = filters?.accountId
  const agentId = filters?.agentId
  const agentName = filters?.agentName
  const startedFrom = filters?.startedFrom
  const startedTo = filters?.startedTo
  const transport = filters?.transport
  const transportKey = (transport ?? []).slice().sort().join(',')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .listSessions(limit, offset, { q, accountId, agentId, agentName, startedFrom, startedTo, transport })
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
  }, [api, limit, offset, q, accountId, agentId, agentName, startedFrom, startedTo, transportKey, refetchTick])

  return { sessions, meta, loading, error, refetch }
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
  const events = session?.events ?? null
  return useMemo(() => sortEventsByCreatedAt(events), [events])
}

export function useOptions(): Record<string, unknown> | null {
  const { session } = useObservabilityContext()
  return session?.options ?? null
}

export function useSessionEvaluations(): SessionExternalEvaluation[] {
  const { session } = useObservabilityContext()
  return session?.evaluations ?? []
}

export function useSessionTags(): SessionTag[] {
  const { session } = useObservabilityContext()
  return session?.tags ?? []
}

export function useSessionOutcome(): SessionOutcome | null {
  const { session } = useObservabilityContext()
  return session?.outcome ?? null
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
  const [refetchTick, setRefetchTick] = useState(0)
  const refetch = useMemo(() => () => setRefetchTick((v) => v + 1), [])

  const { agentId, framework, testingFramework, accountId, startedFrom, startedTo } = filters ?? {}
  // Stable string keys for the array filters so effect deps don't churn
  // on new-but-equal-array identities every render.
  const frameworkKey = (framework ?? []).slice().sort().join(',')
  const testingFrameworkKey = (testingFramework ?? []).slice().sort().join(',')

  // Sync offset when the caller passes a live initialOffset (e.g. from URL
  // state). Callers who drive pagination via setOffset pass a stable 0 and
  // this no-ops after mount.
  useEffect(() => {
    setOffset(initialOffset)
  }, [initialOffset])

  useEffect(() => {
    setOffset(0)
  }, [agentId, frameworkKey, testingFrameworkKey, accountId, startedFrom, startedTo])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .listEvalRuns(limit, offset, {
        agentId,
        framework: framework && framework.length ? framework : undefined,
        testingFramework:
          testingFramework && testingFramework.length ? testingFramework : undefined,
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
  }, [api, limit, offset, agentId, frameworkKey, testingFrameworkKey, accountId, startedFrom, startedTo, refetchTick])

  // Live polling while any visible row is in-flight. Cleared as soon as
  // every row has finalized — keeps a finished page idle. 1500ms is fast
  // enough to feel live without pummelling the API; matches PR #45.
  const anyRunning = useMemo(
    () => runs.some((r) => r.status === 'running'),
    [runs],
  )
  useEffect(() => {
    if (!anyRunning) return
    const id = setInterval(() => setRefetchTick((v) => v + 1), 1500)
    return () => clearInterval(id)
  }, [anyRunning])

  return { runs, meta, loading, error, offset, setOffset, refetch }
}

export function useEvalRun(runId: string | undefined) {
  const { api } = useObservabilityContext()
  const [run, setRun] = useState<EvalRunDetail | null>(null)
  const [loading, setLoading] = useState(!!runId)
  const [error, setError] = useState<string | null>(null)
  const [refetchTick, setRefetchTick] = useState(0)
  const refetch = useMemo(() => () => setRefetchTick((v) => v + 1), [])

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
  }, [api, runId, refetchTick])

  // Live polling — when this run is still in flight, re-fetch every
  // 1.5s so streamed cases (S2.5 flusher) appear on the detail page
  // without a manual refresh. Same cadence as useEvalRuns. Effect
  // tears down the moment the status leaves 'running'.
  const isRunning = run?.status === 'running'
  useEffect(() => {
    if (!isRunning) return
    const id = setInterval(() => setRefetchTick((v) => v + 1), 1500)
    return () => clearInterval(id)
  }, [isRunning])

  return { run, loading, error, refetch }
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

// ---------------------------------------------------------------------------
// useAgents — distinct agent_name rollup across sessions + eval_runs
// ---------------------------------------------------------------------------

export function useAgents(
  limit = 50,
  offset = 0,
  filters?: AgentsFilters,
) {
  const { api } = useObservabilityContext()
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [meta, setMeta] = useState<PlivoMeta>({
    limit,
    offset,
    total_count: 0,
    next: null,
    previous: null,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refetchTick, setRefetchTick] = useState(0)
  const refetch = useMemo(() => () => setRefetchTick((v) => v + 1), [])

  const accountId = filters?.accountId
  const agentId = filters?.agentId
  const agentName = filters?.agentName
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .listAgents(limit, offset, { accountId, agentId, agentName })
      .then((res) => {
        if (cancelled) return
        setAgents(res.objects)
        setMeta(res.meta)
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, limit, offset, accountId, agentId, agentName, refetchTick])

  return { agents, meta, loading, error, refetch }
}

export function useAgent(agentId: string | undefined, accountId?: string | null) {
  const { api } = useObservabilityContext()
  const [agent, setAgent] = useState<AgentRow | null>(null)
  const [loading, setLoading] = useState(!!agentId)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!agentId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .getAgent(agentId, accountId)
      .then((res) => !cancelled && setAgent(res))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [api, agentId, accountId])

  return { agent, loading, error }
}

export function useAgentStats(
  agentId: string | undefined,
  range: AgentStatsRange = '24h',
  accountId?: string | null,
) {
  const { api } = useObservabilityContext()
  const [stats, setStats] = useState<AgentStats | null>(null)
  const [loading, setLoading] = useState(!!agentId)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!agentId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .getAgentStats(agentId, range, accountId)
      .then((res) => !cancelled && setStats(res))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [api, agentId, range, accountId])

  return { stats, loading, error }
}

export function useFleetStats(
  range: AgentStatsRange = '7d',
  accountId?: string | null,
) {
  const { api } = useObservabilityContext()
  const [stats, setStats] = useState<FleetStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .getFleetStats(range, accountId)
      .then((res) => !cancelled && setStats(res))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [api, range, accountId])

  return { stats, loading, error }
}

export function useConversationEvals(
  agentId: string | undefined,
  limit = 50,
  offset = 0,
  filters?: {
    accountId?: string | null
    sessionId?: string | null
    failedOnly?: boolean
  },
) {
  const { api } = useObservabilityContext()
  const [evals, setEvals] = useState<ConversationEvalSummary[]>([])
  const [meta, setMeta] = useState<PlivoMeta>({
    limit,
    offset,
    total_count: 0,
    next: null,
    previous: null,
  })
  const [loading, setLoading] = useState(!!agentId)
  const [error, setError] = useState<string | null>(null)

  const accountId = filters?.accountId ?? null
  const sessionId = filters?.sessionId ?? null
  const failedOnly = !!filters?.failedOnly

  useEffect(() => {
    if (!agentId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .listConversationEvals(agentId, limit, offset, { accountId, sessionId, failedOnly })
      .then((res) => {
        if (cancelled) return
        setEvals(res.objects)
        setMeta(res.meta)
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [api, agentId, limit, offset, accountId, sessionId, failedOnly])

  return { evals, meta, loading, error }
}

// ---------------------------------------------------------------------------
// useGoalResults — sessions with goal verdicts for one agent, plus the
// agent-wide met/unmet summary the tab header renders.
// ---------------------------------------------------------------------------

export function useGoalResults(
  agentId: string | undefined,
  limit = 50,
  offset = 0,
  filters?: { accountId?: string | null },
) {
  const { api } = useObservabilityContext()
  const [results, setResults] = useState<GoalSessionResult[]>([])
  const [summary, setSummary] = useState<GoalResultsSummary>({
    sessions_total: 0,
    met_total: 0,
    unmet_total: 0,
  })
  const [meta, setMeta] = useState<PlivoMeta>({
    limit,
    offset,
    total_count: 0,
    next: null,
    previous: null,
  })
  const [loading, setLoading] = useState(!!agentId)
  const [error, setError] = useState<string | null>(null)

  const accountId = filters?.accountId ?? null

  useEffect(() => {
    if (!agentId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .listGoalResults(agentId, limit, offset, { accountId })
      .then((res) => {
        if (cancelled) return
        setResults(res.objects)
        setMeta(res.meta)
        setSummary(res.summary)
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [api, agentId, limit, offset, accountId])

  return { results, summary, meta, loading, error }
}
