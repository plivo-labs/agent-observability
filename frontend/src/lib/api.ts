import type { AgentSessionRow, PaginatedResponse } from './types'

const BASE = '/api'

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

export const api = {
  listSessions: (page = 1, limit = 50, accountId?: string) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) })
    if (accountId) params.set('account_id', accountId)
    return fetchJson<PaginatedResponse<AgentSessionRow>>(`/sessions?${params}`)
  },

  getSession: (id: string) =>
    fetchJson<AgentSessionRow>(`/sessions/${id}`),
}
