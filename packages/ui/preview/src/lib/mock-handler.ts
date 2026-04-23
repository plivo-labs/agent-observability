export interface MockData {
  sessions: Array<{ session_id: string } & Record<string, unknown>>
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

  return json({ error: 'Not found' }, 404)
}
