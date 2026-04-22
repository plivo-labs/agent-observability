import { Badge } from '@/components/ui/badge'
import type { CaseStatus, JudgmentVerdict } from '@/lib/observability-types'

export function CaseStatusBadge({ status }: { status: CaseStatus }) {
  const cls = {
    passed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
    failed: 'bg-destructive/15 text-destructive border-destructive/30',
    errored: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30',
    skipped: 'bg-muted text-muted-foreground border-border',
  }[status]
  return (
    <Badge variant="outline" className={`text-xxs-400 ${cls}`}>
      {status}
    </Badge>
  )
}

export function VerdictBadge({ verdict }: { verdict: JudgmentVerdict }) {
  const cls = {
    pass: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
    fail: 'bg-destructive/15 text-destructive border-destructive/30',
    maybe: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30',
  }[verdict]
  return (
    <Badge variant="outline" className={`text-xxs-400 ${cls}`}>
      {verdict}
    </Badge>
  )
}
