import { useMemo } from 'react'

/**
 * Expand a single-date filter value into an ISO day window.
 *
 * The data-table date filter emits the picked day's midnight (local) as an
 * epoch-ms string. We expand it into a 00:00 → 23:59:59.999 (local) window so
 * the query returns every row that started during that calendar day.
 *
 * Pass the raw filter array (`parseAsArrayOf` output); only the first entry is
 * read. Returns the parsed `Date` plus its ISO start/end bounds (all
 * `undefined` when no valid date is set).
 */
export function useDayFilter(value: string[]): {
  day: Date | undefined
  fromIso: string | undefined
  toIso: string | undefined
} {
  const day = useMemo(() => {
    const v = value[0]
    if (!v) return undefined
    const d = new Date(Number(v))
    return Number.isNaN(d.getTime()) ? undefined : d
  }, [value])
  const fromIso = useMemo(() => day?.toISOString(), [day])
  const toIso = useMemo(() => {
    if (!day) return undefined
    const end = new Date(day)
    end.setHours(23, 59, 59, 999)
    return end.toISOString()
  }, [day])
  return { day, fromIso, toIso }
}
