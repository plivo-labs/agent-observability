import { describe, expect, test } from 'bun:test'
import { countVerdicts } from '../registry/new-york/session-evaluations-drawer/verdict-counts'

describe('session evaluations drawer totals', () => {
  test('an unknown verdict is counted, as neither a pass nor a fail', () => {
    const counts = countVerdicts([
      { verdict: 'pass' },
      { verdict: 'fail' },
      { verdict: 'maybe' },
      { verdict: 'unknown' },
      { verdict: 'unknown' },
    ])
    expect(counts).toEqual({ pass: 1, fail: 1, maybe: 1, unknown: 2, total: 5 })
  })
})
