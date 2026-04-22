import type {
  AgentSessionRow,
  EvalCaseRow,
  EvalRunDetail,
  EvalRunRow,
  EvalsFilters,
  PlivoListResponse,
  SessionsFilters,
} from '@/lib/observability-types'

export function createObservabilityApi(baseUrl: string) {
  async function fetchJson<T>(path: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`)
    if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`)
    return res.json()
  }

  return {
    listSessions: (limit = 20, offset = 0, filters?: SessionsFilters) => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
      if (filters?.accountId) params.set('account_id', filters.accountId)
      if (filters?.startedFrom) params.set('started_from', filters.startedFrom)
      if (filters?.startedTo) params.set('started_to', filters.startedTo)
      if (filters?.transport && filters.transport.length) {
        params.set('transport', filters.transport.join(','))
      }
      return fetchJson<PlivoListResponse<AgentSessionRow>>(`/sessions?${params}`)
    },

    getSession: (id: string) =>
      fetchJson<AgentSessionRow>(`/sessions/${id}`),

    listEvalRuns: (limit = 20, offset = 0, filters?: EvalsFilters) => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
      if (filters?.agentId) params.set('agent_id', filters.agentId)
      if (filters?.framework && filters.framework.length) {
        params.set('framework', filters.framework.join(','))
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
  }
}

export type ObservabilityApi = ReturnType<typeof createObservabilityApi>
