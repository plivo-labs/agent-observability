// Dashboard-only API client for the supervisor review surface —
// intentionally NOT part of the packages/ui registry twins (precedent:
// alerts-api.ts / not-found-page.tsx). Keeps the published
// observability-api surface untouched.

/** A verdict is binary: the axis fired ("flagged") or it didn't ("clear"). */
export type SupervisorVerdict = 'flagged' | 'clear'

/** Prompt-edit suggestion attached to a misflagged case. `add`/`remove` are
 *  rubric lines to append / strike; `rationale` explains the change. Any of
 *  the three can be empty even when the object is present. */
export interface SuggestedFix {
  add: string[]
  remove: string[]
  rationale: string
}

/** Top-level row: one judge axis with its review tally. */
export interface SupervisorAxisSummary {
  axis: string
  label: string
  misflags: number
  reviewed: number
  last_at: string | null
}

/** A single misflagged verdict — the supervisor disagreed with the judge. */
export interface SupervisorCase {
  session_id: string
  axis: string
  node_ref: string | null
  node_name: string | null
  original_verdict: SupervisorVerdict
  original_reason: string
  supervisor_verdict: SupervisorVerdict
  supervisor_reason: string
  votes_for: number
  votes_total: number
  suggested_fix: SuggestedFix | null
  supervisor_model: string
  observed_at: string
  created_at: string
}

export interface SupervisorAxisDetail {
  axis: string
  label: string
  objects: SupervisorCase[]
}

interface ListResponse<T> {
  objects: T[]
}

export function createSupervisorApi(baseUrl: string) {
  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, init)
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`
      try {
        const body = await res.json()
        if (body?.error?.message) detail = body.error.message
      } catch {}
      throw new Error(detail)
    }
    return res.json()
  }

  return {
    /** Top level: one row per judge axis, sorted misflags-desc server-side. */
    listAxes: () => fetchJson<ListResponse<SupervisorAxisSummary>>('/supervisor'),
    /** Drill-down: the misflagged cases for one axis + suggested fixes. */
    getAxis: (axis: string, limit = 100) =>
      fetchJson<SupervisorAxisDetail>(
        `/supervisor/${encodeURIComponent(axis)}?limit=${limit}`,
      ),
  }
}

export type SupervisorApi = ReturnType<typeof createSupervisorApi>

/** Shared dashboard instance — the supervisor pages all talk to /api. */
export const supervisorApi = createSupervisorApi('/api')
