import type { AgentSessionRow, PlivoListResponse } from '@/lib/observability-types'

export function createObservabilityApi(baseUrl: string) {
  async function fetchJson<T>(path: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`)
    if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`)
    return res.json()
  }

  return {
    listSessions: (limit = 20, offset = 0, accountId?: string) => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
      if (accountId) params.set('account_id', accountId)
      return fetchJson<PlivoListResponse<AgentSessionRow>>(`/sessions?${params}`)
    },

    getSession: (id: string) =>
      fetchJson<AgentSessionRow>(`/sessions/${id}`),
  }
}

export type ObservabilityApi = ReturnType<typeof createObservabilityApi>
