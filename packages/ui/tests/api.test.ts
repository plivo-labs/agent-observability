import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { createObservabilityApi } from '../registry/new-york/observability-api/api'

const mockSession = {
  id: 1,
  session_id: 'sess_123',
  account_id: 'acc_001',
  state: 'ended',
  transport: 'sip',
  started_at: '2026-04-14T10:00:00Z',
  ended_at: '2026-04-14T10:01:00Z',
  duration_ms: 60000,
  turn_count: 2,
  has_stt: true,
  has_llm: true,
  has_tts: true,
  chat_history: null,
  session_metrics: null,
  record_url: null,
  created_at: '2026-04-14T10:00:00Z',
}

const mockListResponse = {
  api_id: 'test',
  meta: { limit: 20, offset: 0, total_count: 1, next: null, previous: null },
  objects: [mockSession],
}

describe('createObservabilityApi', () => {
  beforeEach(() => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockListResponse),
      } as Response),
    )
  })

  test('listSessions calls correct URL with defaults', async () => {
    const api = createObservabilityApi('https://example.com/api')
    await api.listSessions()

    expect(fetch).toHaveBeenCalledTimes(1)
    const url = (fetch as any).mock.calls[0][0] as string
    expect(url).toContain('https://example.com/api/sessions')
    expect(url).toContain('limit=20')
    expect(url).toContain('offset=0')
  })

  test('listSessions passes custom limit and offset', async () => {
    const api = createObservabilityApi('https://example.com/api')
    await api.listSessions(50, 100)

    const url = (fetch as any).mock.calls[0][0] as string
    expect(url).toContain('limit=50')
    expect(url).toContain('offset=100')
  })

  test('listSessions includes account_id when provided', async () => {
    const api = createObservabilityApi('https://example.com/api')
    await api.listSessions(20, 0, { accountId: 'acc_123' })

    const url = (fetch as any).mock.calls[0][0] as string
    expect(url).toContain('account_id=acc_123')
  })

  test('listSessions includes started_from/started_to when provided', async () => {
    const api = createObservabilityApi('https://example.com/api')
    await api.listSessions(20, 0, {
      startedFrom: '2026-04-01T00:00:00.000Z',
      startedTo: '2026-04-30T23:59:59.999Z',
    })

    const url = (fetch as any).mock.calls[0][0] as string
    expect(url).toContain(`started_from=${encodeURIComponent('2026-04-01T00:00:00.000Z')}`)
    expect(url).toContain(`started_to=${encodeURIComponent('2026-04-30T23:59:59.999Z')}`)
  })

  test('listSessions combines account_id with date range', async () => {
    const api = createObservabilityApi('https://example.com/api')
    await api.listSessions(20, 0, {
      accountId: 'acc_123',
      startedFrom: '2026-04-01T00:00:00.000Z',
      startedTo: '2026-04-30T23:59:59.999Z',
    })

    const url = (fetch as any).mock.calls[0][0] as string
    expect(url).toContain('account_id=acc_123')
    expect(url).toContain('started_from=')
    expect(url).toContain('started_to=')
  })

  test('listSessions omits filter params when filters object is empty', async () => {
    const api = createObservabilityApi('https://example.com/api')
    await api.listSessions(20, 0, {})

    const url = (fetch as any).mock.calls[0][0] as string
    expect(url).not.toContain('account_id=')
    expect(url).not.toContain('started_from=')
    expect(url).not.toContain('started_to=')
  })

  test('listSessions returns parsed response', async () => {
    const api = createObservabilityApi('https://example.com/api')
    const result = await api.listSessions()

    expect(result.objects).toHaveLength(1)
    expect(result.objects[0].session_id).toBe('sess_123')
    expect(result.meta.total_count).toBe(1)
  })

  test('getSession calls correct URL', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockSession),
      } as Response),
    )

    const api = createObservabilityApi('https://example.com/api')
    const result = await api.getSession('sess_123')

    const url = (fetch as any).mock.calls[0][0] as string
    expect(url).toBe('https://example.com/api/sessions/sess_123')
    expect(result.session_id).toBe('sess_123')
  })

  test('throws on non-ok response', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response),
    )

    const api = createObservabilityApi('https://example.com/api')
    expect(api.getSession('bad_id')).rejects.toThrow('API error: 404 Not Found')
  })
})
