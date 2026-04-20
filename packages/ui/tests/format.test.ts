import { describe, expect, test } from 'bun:test'
import {
  formatMs,
  formatDuration,
  formatDate,
  computeAvg,
  computePercentile,
} from '../registry/new-york/observability-format/format'

describe('formatMs', () => {
  test('sub-millisecond returns <1ms', () => {
    expect(formatMs(0.5)).toBe('<1ms')
    expect(formatMs(0)).toBe('<1ms')
  })

  test('milliseconds under 1s', () => {
    expect(formatMs(1)).toBe('1ms')
    expect(formatMs(150)).toBe('150ms')
    expect(formatMs(999)).toBe('999ms')
  })

  test('rounds to nearest ms', () => {
    expect(formatMs(150.7)).toBe('151ms')
    expect(formatMs(99.4)).toBe('99ms')
  })

  test('seconds with two decimals', () => {
    expect(formatMs(1000)).toBe('1.00s')
    expect(formatMs(1500)).toBe('1.50s')
    expect(formatMs(2345)).toBe('2.35s')
    expect(formatMs(10000)).toBe('10.00s')
  })
})

describe('formatDuration', () => {
  test('null returns dash', () => {
    expect(formatDuration(null)).toBe('—')
  })

  test('seconds only', () => {
    expect(formatDuration(5000)).toBe('5s')
    expect(formatDuration(59000)).toBe('59s')
  })

  test('minutes and seconds', () => {
    expect(formatDuration(60000)).toBe('1m 0s')
    expect(formatDuration(90000)).toBe('1m 30s')
    expect(formatDuration(125000)).toBe('2m 5s')
  })

  test('hours, minutes, and seconds', () => {
    expect(formatDuration(3600000)).toBe('1h 0m 0s')
    expect(formatDuration(3661000)).toBe('1h 1m 1s')
    expect(formatDuration(7384000)).toBe('2h 3m 4s')
  })

  test('zero returns 0s', () => {
    expect(formatDuration(0)).toBe('0s')
  })
})

describe('formatDate', () => {
  test('null returns dash', () => {
    expect(formatDate(null)).toBe('—')
  })

  test('formats ISO date string', () => {
    const result = formatDate('2026-04-14T10:00:00Z')
    // Exact output depends on timezone, but it should contain the date parts
    expect(result).toContain('Apr')
    expect(result).toContain('14')
    expect(result).toContain('2026')
  })

  test('empty string returns dash', () => {
    expect(formatDate('')).toBe('—')
  })
})

describe('computeAvg', () => {
  test('empty array returns 0', () => {
    expect(computeAvg([])).toBe(0)
  })

  test('single value', () => {
    expect(computeAvg([100])).toBe(100)
  })

  test('averages and rounds', () => {
    expect(computeAvg([100, 200, 300])).toBe(200)
    expect(computeAvg([1, 2])).toBe(2) // 1.5 rounds to 2
    expect(computeAvg([10, 20, 30, 40])).toBe(25)
  })
})

describe('computePercentile', () => {
  test('empty array returns 0', () => {
    expect(computePercentile([], 0.95)).toBe(0)
  })

  test('single value returns that value', () => {
    expect(computePercentile([42], 0.95)).toBe(42)
  })

  test('p95 of sorted values', () => {
    const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    const p95 = computePercentile(values, 0.95)
    expect(p95).toBe(1000) // index 9 (floor(10 * 0.95) = 9)
  })

  test('p50 is median', () => {
    const values = [10, 20, 30, 40, 50]
    expect(computePercentile(values, 0.5)).toBe(30) // index 2
  })

  test('unsorted input is handled correctly', () => {
    const values = [500, 100, 300, 200, 400]
    expect(computePercentile(values, 0.5)).toBe(300)
  })

  test('does not mutate input array', () => {
    const values = [3, 1, 2]
    computePercentile(values, 0.5)
    expect(values).toEqual([3, 1, 2])
  })
})
