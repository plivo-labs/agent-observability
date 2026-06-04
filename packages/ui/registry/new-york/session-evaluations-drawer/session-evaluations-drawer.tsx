import type { ReactNode } from 'react'
import {
  CircleAlert,
  CheckCircle2,
  CircleHelp,
  ClipboardCheck,
  ListChecks,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/observability-format'
import {
  useSessionEvaluations,
  useSessionOutcome,
} from '@/lib/observability-hooks'
import type { SessionExternalEvaluation } from '@/lib/observability-types'

interface SessionEvaluationsDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function labelFor(value: string | null | undefined, fallback = 'Unknown') {
  if (!value) return fallback
  return value.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function resultTone(value: string | null | undefined) {
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

function ResultBadge({ value }: { value: string | null | undefined }) {
  const tone = resultTone(value)
  const icon =
    tone === 'success' ? (
      <CheckCircle2 size={12} />
    ) : tone === 'fail' ? (
      <XCircle size={12} />
    ) : tone === 'maybe' ? (
      <CircleAlert size={12} />
    ) : (
      <CircleHelp size={12} />
    )

  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1',
        tone === 'success' && 'border-success bg-success text-success-foreground',
        tone === 'maybe' && 'border-warning bg-warning text-warning-foreground',
        tone === 'fail' && 'border-destructive bg-destructive text-destructive-foreground',
      )}
    >
      {icon}
      {labelFor(value, 'Pending')}
    </Badge>
  )
}

function SummaryTile({
  label,
  value,
  children,
}: {
  label: string
  value: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="ao-stat">
      <div className="ao-stat-label">{label}</div>
      <div className="flex min-h-7 items-center gap-2 text-sm font-medium">{value}</div>
      {children}
    </div>
  )
}

function EvaluationDetail({
  label,
  value,
  muted = false,
}: {
  label: string
  value: string | null | undefined
  muted?: boolean
}) {
  if (!value) return null

  return (
    <div className="space-y-1.5 border-t pt-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          'text-sm leading-6',
          muted ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {value}
      </div>
    </div>
  )
}

function EvaluationRow({ evaluation }: { evaluation: SessionExternalEvaluation }) {
  const tone = resultTone(evaluation.verdict)

  return (
    <div
      className={cn(
        'rounded-lg border border-l-4 bg-card p-4',
        tone === 'success' && 'border-success-border border-l-success bg-success-bg',
        tone === 'maybe' && 'border-warning-border border-l-warning bg-warning-bg',
        tone === 'fail' && 'border-destructive-border border-l-destructive bg-destructive-bg',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {evaluation.judge_name || 'Evaluation'}
          </div>
          {evaluation.observed_at && (
            <div className="mt-1 text-xs text-muted-foreground">
              {formatDate(evaluation.observed_at)}
            </div>
          )}
        </div>
        <ResultBadge value={evaluation.verdict} />
      </div>

      <div className="mt-4 space-y-3">
        <EvaluationDetail label="Reasoning" value={evaluation.reasoning} />
        <EvaluationDetail label="Instructions" value={evaluation.instructions} muted />
      </div>
    </div>
  )
}

export function SessionEvaluationsDrawer({
  open,
  onOpenChange,
}: SessionEvaluationsDrawerProps) {
  const evaluations = useSessionEvaluations()
  const outcome = useSessionOutcome()
  const hasEvaluationData = evaluations.length > 0 || !!outcome

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full overflow-y-auto p-0 sm:max-w-xl md:max-w-2xl"
        showCloseButton
      >
        <SheetHeader className="border-b px-5 py-4">
          <div className="ao-hero-eyebrow !mb-1">
            <ClipboardCheck />
            Evaluation
          </div>
          <SheetTitle className="font-[family-name:var(--font-display)] text-xl tracking-tight">
            Judge results
          </SheetTitle>
          <SheetDescription>
            {evaluations.length} evaluation{evaluations.length !== 1 ? 's' : ''} for this session
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 p-5">
          <div className="ao-stat-row">
            <SummaryTile
              label="Outcome"
              value={outcome ? <ResultBadge value={outcome.outcome} /> : 'Pending'}
            >
              {outcome?.reason && (
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{outcome.reason}</p>
              )}
            </SummaryTile>
            <SummaryTile label="Evaluations" value={evaluations.length} />
          </div>

          {!hasEvaluationData && (
            <div className="ao-empty">
              <div className="ao-empty-icon">
                <ClipboardCheck />
              </div>
              <div className="ao-empty-title">No evaluations</div>
              <div className="ao-empty-text">No evaluations were captured for this session.</div>
            </div>
          )}

          {evaluations.length > 0 && (
            <section className="flex flex-col gap-3">
              <div className="ao-section-label !mb-0 flex items-center gap-2">
                <ListChecks size={13} />
                Judge results
              </div>
              {evaluations.map((evaluation, index) => (
                <EvaluationRow
                  key={`${evaluation.source}-${evaluation.judge_name}-${evaluation.created_at}-${index}`}
                  evaluation={evaluation}
                />
              ))}
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
