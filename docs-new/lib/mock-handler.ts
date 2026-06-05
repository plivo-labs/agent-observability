export interface MockEvalCase {
  case_id: string
  run_id: string
  [k: string]: unknown
}

export interface MockEvalRun {
  run_id: string
  cases?: MockEvalCase[]
  [k: string]: unknown
}

export interface MockData {
  sessions: Array<{ session_id: string } & Record<string, unknown>>
  evals?: MockEvalRun[]
}

export function handleMockRequest(
  pathname: string,
  search: string,
  data: MockData,
): Response | null {
  if (!pathname.startsWith('/api/')) return null

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  if (pathname === '/api/sessions') {
    return json({
      api_id: 'preview-mock',
      meta: {
        limit: 20,
        offset: 0,
        total_count: data.sessions.length,
        next: null,
        previous: null,
      },
      objects: data.sessions,
    })
  }

  const detailMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/)
  if (detailMatch) {
    const id = detailMatch[1]
    const session =
      data.sessions.find((s) => s.session_id === id) ?? data.sessions[0]
    return json(session)
  }

  if (pathname === '/api/evals') {
    const runs = (data.evals ?? []).map(({ cases: _cases, ...row }) => row)
    return json({
      api_id: 'preview-mock',
      meta: {
        limit: 20,
        offset: 0,
        total_count: runs.length,
        next: null,
        previous: null,
      },
      objects: runs,
    })
  }

  const caseMatch = pathname.match(/^\/api\/evals\/([^/]+)\/cases\/([^/]+)$/)
  if (caseMatch) {
    const [, runId, caseId] = caseMatch
    const run = (data.evals ?? []).find((r) => r.run_id === runId)
    const c = run?.cases?.find((x) => x.case_id === caseId) ?? run?.cases?.[0]
    if (!c) return json({ error: 'Not found' }, 404)
    return json({ ...c, api_id: 'preview-mock' })
  }

  const runMatch = pathname.match(/^\/api\/evals\/([^/]+)$/)
  if (runMatch) {
    const [, runId] = runMatch
    const run = (data.evals ?? []).find((r) => r.run_id === runId) ?? (data.evals ?? [])[0]
    if (!run) return json({ error: 'Not found' }, 404)
    return json({ ...run, api_id: 'preview-mock' })
  }

  return json({ error: 'Not found' }, 404)
}
