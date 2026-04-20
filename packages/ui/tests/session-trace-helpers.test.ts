import { describe, expect, test } from 'bun:test'
import {
  parseMs,
  computeTickInterval,
  computeSessionBounds,
} from '../registry/new-york/session-timeline/session-trace'
import type { SessionMetrics } from '../registry/new-york/observability-types/types'

describe('parseMs', () => {
  test('undefined returns null', () => {
    expect(parseMs(undefined)).toBeNull()
  })

  test('empty string returns null', () => {
    expect(parseMs('')).toBeNull()
  })

  test('valid ISO string returns epoch ms', () => {
    const result = parseMs('2026-04-14T10:00:00Z')
    expect(result).toBe(new Date('2026-04-14T10:00:00Z').getTime())
  })

  test('invalid date returns null', () => {
    expect(parseMs('not-a-date')).toBeNull()
  })
})

describe('computeTickInterval', () => {
  test('short sessions (<=20s) → 2s ticks', () => {
    expect(computeTickInterval(5000)).toBe(2000)
    expect(computeTickInterval(20000)).toBe(2000)
  })

  test('medium sessions (<=60s) → 5s ticks', () => {
    expect(computeTickInterval(30000)).toBe(5000)
    expect(computeTickInterval(60000)).toBe(5000)
  })

  test('long sessions (<=180s) → 10s ticks', () => {
    expect(computeTickInterval(120000)).toBe(10000)
    expect(computeTickInterval(180000)).toBe(10000)
  })

  test('very long sessions (>180s) → 30s ticks', () => {
    expect(computeTickInterval(200000)).toBe(30000)
    expect(computeTickInterval(600000)).toBe(30000)
  })
})

describe('computeSessionBounds', () => {
  test('null metrics returns empty bounds', () => {
    const bounds = computeSessionBounds(null)
    expect(bounds.totalMs).toBe(0)
    expect(bounds.sessionStartMs).toBe(0)
    expect(bounds.sessionEndMs).toBe(0)
  })

  test('empty turns returns empty bounds', () => {
    const metrics: SessionMetrics = {
      turns: [],
      tool_calls: [],
      summary: {} as any,
    }
    const bounds = computeSessionBounds(metrics)
    expect(bounds.totalMs).toBe(0)
  })

  test('turns without timestamps returns empty bounds', () => {
    const metrics: SessionMetrics = {
      turns: [
        {
          turn_number: 1,
          turn_id: 't1',
          user_text: 'hello',
          agent_text: 'hi',
          agent_first: false,
          interrupted: false,
        },
      ],
      tool_calls: [],
      summary: {} as any,
    }
    const bounds = computeSessionBounds(metrics)
    expect(bounds.totalMs).toBe(0)
  })

  test('computes bounds from turn timestamps', () => {
    const metrics: SessionMetrics = {
      turns: [
        {
          turn_number: 1,
          turn_id: 't1',
          user_text: 'hello',
          agent_text: 'hi',
          agent_first: false,
          interrupted: false,
          user_started_speaking_at: '2026-04-14T10:00:00Z',
          user_stopped_speaking_at: '2026-04-14T10:00:03Z',
          agent_started_speaking_at: '2026-04-14T10:00:04Z',
          agent_stopped_speaking_at: '2026-04-14T10:00:08Z',
        },
        {
          turn_number: 2,
          turn_id: 't2',
          user_text: 'bye',
          agent_text: 'goodbye',
          agent_first: false,
          interrupted: false,
          user_started_speaking_at: '2026-04-14T10:00:10Z',
          user_stopped_speaking_at: '2026-04-14T10:00:12Z',
          agent_started_speaking_at: '2026-04-14T10:00:13Z',
          agent_stopped_speaking_at: '2026-04-14T10:00:16Z',
        },
      ],
      tool_calls: [],
      summary: {} as any,
    }

    const bounds = computeSessionBounds(metrics)
    expect(bounds.sessionStartMs).toBe(new Date('2026-04-14T10:00:00Z').getTime())
    expect(bounds.sessionEndMs).toBe(new Date('2026-04-14T10:00:16Z').getTime())
    expect(bounds.totalMs).toBeGreaterThan(0)
    expect(bounds.tickInterval).toBeGreaterThan(0)
  })
})
