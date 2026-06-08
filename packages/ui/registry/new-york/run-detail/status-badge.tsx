import { cn } from '@/lib/utils'
import type { CaseStatus } from '@/lib/observability-types'

/** Maps a case status to its `ao-badge` tone modifier. */
const STATUS_TONE: Record<CaseStatus, string> = {
  passed: 'is-success',
  failed: 'is-danger',
  errored: 'is-warning',
  skipped: 'is-neutral',
}

/** Human label for a case status. */
export const STATUS_LABEL: Record<CaseStatus, string> = {
  passed: 'Passed',
  failed: 'Failed',
  errored: 'Errored',
  skipped: 'Skipped',
}

/** Shared eval case status badge — dot + token-tinted `ao-badge` tone. Used by
 * the eval-run-detail case table and the eval-case-detail hero. */
export function StatusBadge({ status }: { status: CaseStatus }) {
  return (
    <span className={cn('ao-badge ao-badge--dot', STATUS_TONE[status])}>
      {STATUS_LABEL[status]}
    </span>
  )
}
