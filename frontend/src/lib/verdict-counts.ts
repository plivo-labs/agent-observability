type VerdictTone = 'success' | 'fail' | 'maybe' | 'neutral'

export function resultTone(value: string | null | undefined): VerdictTone {
  const normalized = value?.toLowerCase()
  if (normalized === 'pass' || normalized === 'passed' || normalized === 'success') {
    return 'success'
  }
  if (normalized === 'fail' || normalized === 'failed' || normalized === 'failure') {
    return 'fail'
  }
  if (normalized === 'maybe' || normalized === 'warning') {
    return 'maybe'
  }
  return 'neutral'
}

export interface VerdictCounts {
  pass: number
  fail: number
  maybe: number
  unknown: number
  total: number
}

/** Anything that is not a pass, fail or maybe counts as unknown, so the total
 *  matches the number of evaluations rather than hiding undecided ones. */
export function countVerdicts(evaluations: ReadonlyArray<{ verdict: string | null | undefined }>): VerdictCounts {
  const counts: VerdictCounts = { pass: 0, fail: 0, maybe: 0, unknown: 0, total: evaluations.length }
  for (const { verdict } of evaluations) {
    const tone = resultTone(verdict)
    if (tone === 'success') counts.pass++
    else if (tone === 'fail') counts.fail++
    else if (tone === 'maybe') counts.maybe++
    else counts.unknown++
  }
  return counts
}
