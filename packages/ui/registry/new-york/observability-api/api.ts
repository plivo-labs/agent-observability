import type {
  AgentRow,
  AgentSessionRow,
  AgentStats,
  AgentStatsRange,
  AgentsFilters,
  ConversationEvalSummary,
  EvalCaseRow,
  EvalRunDetail,
  EvalRunRow,
  EvalsFilters,
  FleetStats,
  PlivoListResponse,
  SessionsFilters,
} from '@/lib/observability-types'

export function createObservabilityApi(baseUrl: string) {
  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, init)
    if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`)
    return res.json()
  }

  return {
    listSessions: (limit = 20, offset = 0, filters?: SessionsFilters) => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
      if (filters?.q) params.set('q', filters.q)
      if (filters?.accountId) params.set('account_id', filters.accountId)
      if (filters?.agentId) params.set('agent_id', filters.agentId)
      if (filters?.agentName) params.set('agent_name', filters.agentName)
      if (filters?.startedFrom) params.set('started_from', filters.startedFrom)
      if (filters?.startedTo) params.set('started_to', filters.startedTo)
      if (filters?.transport && filters.transport.length) {
        params.set('transport', filters.transport.join(','))
      }
      return fetchJson<PlivoListResponse<AgentSessionRow>>(`/sessions?${params}`)
    },

    listAgents: (limit = 50, offset = 0, filters?: AgentsFilters) => {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      })
      if (filters?.accountId) params.set('account_id', filters.accountId)
      if (filters?.agentId) params.set('agent_id', filters.agentId)
      if (filters?.agentName) params.set('agent_name', filters.agentName)
      return fetchJson<PlivoListResponse<AgentRow>>(`/agents?${params}`)
    },

    getAgent: (agentId: string, accountId?: string | null) => {
      const params = new URLSearchParams()
      if (accountId) params.set('account_id', accountId)
      const qs = params.toString()
      return fetchJson<AgentRow>(`/agents/${encodeURIComponent(agentId)}${qs ? `?${qs}` : ''}`)
    },

    getAgentStats: (
      agentId: string,
      range: AgentStatsRange = '24h',
      accountId?: string | null,
    ) => {
      const params = new URLSearchParams({ range })
      if (accountId) params.set('account_id', accountId)
      return fetchJson<AgentStats>(
        `/agents/${encodeURIComponent(agentId)}/stats?${params}`,
      )
    },

    getFleetStats: (range: AgentStatsRange = '7d', accountId?: string | null) => {
      const params = new URLSearchParams({ range })
      if (accountId) params.set('account_id', accountId)
      return fetchJson<FleetStats>(`/analytics/stats?${params}`)
    },

    listConversationEvals: (
      agentId: string,
      limit = 50,
      offset = 0,
      filters?: {
        accountId?: string | null
        sessionId?: string | null
        failedOnly?: boolean
      },
    ) => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
      if (filters?.accountId) params.set('account_id', filters.accountId)
      if (filters?.sessionId) params.set('session_id', filters.sessionId)
      if (filters?.failedOnly) params.set('failed', 'true')
      return fetchJson<PlivoListResponse<ConversationEvalSummary>>(
        `/agents/${encodeURIComponent(agentId)}/conversation-evals?${params}`,
      )
    },

    getSession: (id: string) =>
      fetchJson<AgentSessionRow>(`/sessions/${id}`),

    deleteSessions: (sessionIds: string[]) =>
      fetchJson<{ api_id: string; deleted: number }>(`/sessions`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_ids: sessionIds }),
      }),

    listEvalRuns: (limit = 20, offset = 0, filters?: EvalsFilters) => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
      if (filters?.agentId) params.set('agent_id', filters.agentId)
      if (filters?.framework && filters.framework.length) {
        params.set('framework', filters.framework.join(','))
      }
      if (filters?.testingFramework && filters.testingFramework.length) {
        params.set('testing_framework', filters.testingFramework.join(','))
      }
      if (filters?.accountId) params.set('account_id', filters.accountId)
      if (filters?.startedFrom) params.set('started_from', filters.startedFrom)
      if (filters?.startedTo) params.set('started_to', filters.startedTo)
      return fetchJson<PlivoListResponse<EvalRunRow>>(`/evals?${params}`)
    },

    getEvalRun: (runId: string) =>
      fetchJson<EvalRunDetail>(`/evals/${runId}`),

    getEvalCase: (runId: string, caseId: string) =>
      fetchJson<EvalCaseRow & { api_id?: string }>(`/evals/${runId}/cases/${caseId}`),

    deleteEvalRuns: (runIds: string[]) =>
      fetchJson<{ api_id: string; deleted: number }>(`/evals`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_ids: runIds }),
      }),

    deleteEvalCases: (runId: string, caseIds: string[]) =>
      fetchJson<{ api_id: string; deleted: number }>(`/evals/${runId}/cases`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ case_ids: caseIds }),
      }),
  }
}

export type ObservabilityApi = ReturnType<typeof createObservabilityApi>
