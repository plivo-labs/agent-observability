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
  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, init)
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
  }
}

export type ObservabilityApi = ReturnType<typeof createObservabilityApi>
