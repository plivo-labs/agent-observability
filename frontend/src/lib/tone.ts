/** App-only health-tone bucketing (not a published registry item).
 *
 * The same 3-way "good / warn / bad" rate bucket was reimplemented across
 * evals / schedules / simulate / obs-cells — each with its OWN thresholds and
 * output form. This centralises the bucketing while keeping thresholds explicit
 * at the call site (they genuinely differ) and lets callers map the tone to
 * whatever they render (a colour var, a `bg-*` class, or the `is-*` class). */
export type Tone = 'good' | 'warn' | 'bad'

export const toneForRate = (rate: number, goodMin = 90, warnMin = 60): Tone =>
  rate >= goodMin ? 'good' : rate >= warnMin ? 'warn' : 'bad'

/** The Neo redesign status class (`is-good` / `is-warn` / `is-bad`). */
export const toneClass = (rate: number, goodMin?: number, warnMin?: number): string =>
  `is-${toneForRate(rate, goodMin, warnMin)}`

/** CSS colour var for a tone (success / warning / destructive). */
export const toneColorVar = (tone: Tone): string =>
  tone === 'good' ? 'hsl(var(--success))' : tone === 'warn' ? 'hsl(var(--warning))' : 'hsl(var(--destructive))'
