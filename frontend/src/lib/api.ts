import type { AgentSessionRow, PlivoListResponse } from './types'

const BASE = '/api'

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

export const api = {
  listSessions: (limit = 20, offset = 0, accountId?: string) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
    if (accountId) params.set('account_id', accountId)
    return fetchJson<PlivoListResponse<AgentSessionRow>>(`/sessions?${params}`)
  },

  getSession: (id: string) =>
    fetchJson<AgentSessionRow>(`/sessions/${id}`),
}
