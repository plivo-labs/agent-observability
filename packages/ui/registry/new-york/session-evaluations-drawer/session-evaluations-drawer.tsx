import type { ReactNode } from 'react'
import {
  CircleAlert,
  CheckCircle2,
  CircleHelp,
  ClipboardCheck,
  ListChecks,
  XCircle,
} from 'lucide-react'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
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

export function ResultBadge({ value }: { value: string | null | undefined }) {
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
        'gap-1 capitalize',
        tone === 'success' &&
          'border-[hsl(var(--success-border))] bg-[hsl(var(--success-bg))] text-[hsl(var(--success-fg,var(--success)))]',
        tone === 'maybe' &&
          'border-[hsl(var(--warning-border))] bg-[hsl(var(--warning-bg))] text-[hsl(var(--warning-fg,var(--warning)))]',
        tone === 'fail' &&
          'border-[hsl(var(--destructive-border))] bg-[hsl(var(--destructive-bg))] text-[hsl(var(--destructive))]',
      )}
    >
      {icon}
      {labelFor(value, '—')}
    </Badge>
  )
}

export function SummaryTile({
  label,
  value,
  children,
}: {
  label: string
  value: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="rounded-lg border bg-card p-3 shadow-sm">
      <div className="text-xxs-600 uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 flex min-h-6 items-center gap-2 text-sm font-medium">
        {value}
      </div>
      {children}
    </div>
  )
}

export function EvaluationDetail({
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
      <div className="text-xxs-600 uppercase tracking-[0.08em] text-muted-foreground">
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

/** Color-coded left-border class per verdict tone — same palette as
 *  ResultBadge so the visual language of "this judge passed / failed /
 *  uncertain" carries across the list. */
function verdictBorderClass(verdict: string | null | undefined): string {
  switch (resultTone(verdict)) {
    case 'success':
      return 'border-l-[hsl(var(--success-fg,var(--success)))]'
    case 'fail':
      return 'border-l-[hsl(var(--destructive))]'
    case 'maybe':
      return 'border-l-[hsl(var(--warning-fg,var(--warning)))]'
    default:
      return 'border-l-border'
  }
}

/**
 * Accordion list of judge results. Used by both the session-level
 * evaluations drawer and the per-session conversation-eval drawer — the
 * shared shape keeps the visual language consistent across surfaces.
 *
 * Each judge is one ``<AccordionItem>``. The trigger shows
 * ``name · timestamp · verdict-badge`` at top level; the body reveals
 * reasoning + instructions on expand. ``type="multiple"`` so several
 * can be open at once when comparing reasoning across disagreeing
 * judges.
 */
export function EvaluationsAccordion({
  evaluations,
}: {
  evaluations: SessionExternalEvaluation[]
}) {
  if (evaluations.length === 0) return null

  return (
    <Accordion type="multiple" className="flex flex-col gap-2">
      {evaluations.map((ev, index) => {
        const itemValue = `${ev.judge_name ?? 'evaluation'}-${index}`
        return (
          <AccordionItem
            key={itemValue}
            value={itemValue}
            className={cn(
              // `last:border-b` cancels shadcn AccordionItem's default
              // `last:border-b-0` so the bottom edge of the last card
              // stays visible. twMerge deduplicates and keeps this.
              'rounded-lg border border-l-4 last:border-b bg-card px-4',
              verdictBorderClass(ev.verdict),
            )}
          >
            <AccordionTrigger className="py-2 hover:no-underline">
              <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 pr-2">
                <span className="text-sm font-medium">
                  {ev.judge_name || 'Evaluation'}
                </span>
                {ev.observed_at && (
                  <span className="text-[11px] text-muted-foreground">
                    {formatDate(ev.observed_at)}
                  </span>
                )}
                <div className="ml-auto">
                  <ResultBadge value={ev.verdict} />
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-3 pb-1">
                <EvaluationDetail label="Reasoning" value={ev.reasoning} />
                <EvaluationDetail
                  label="Instructions"
                  value={ev.instructions}
                  muted
                />
              </div>
            </AccordionContent>
          </AccordionItem>
        )
      })}
    </Accordion>
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
          <SheetTitle className="flex items-center gap-2">
            <ClipboardCheck size={16} />
            Evaluations
          </SheetTitle>
          <SheetDescription>
            {evaluations.length} evaluations
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 p-5">
          {(() => {
            const passCount = evaluations.filter((e) => resultTone(e.verdict) === 'success').length
            const failCount = evaluations.filter((e) => resultTone(e.verdict) === 'fail').length
            const maybeCount = evaluations.filter((e) => resultTone(e.verdict) === 'maybe').length
            return (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <SummaryTile
                  label="Outcome"
                  value={
                    outcome ? (
                      <ResultBadge value={outcome.outcome.replace(/^lk\./, '')} />
                    ) : (
                      // Match the conversation-evals drawer + table column:
                      // a session without an outcome isn't "pending", it
                      // just has no value. Use the same muted "—" everywhere.
                      <span className="text-muted-foreground">—</span>
                    )
                  }
                >
                  {outcome?.reason && (
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">{outcome.reason}</p>
                  )}
                </SummaryTile>
                <SummaryTile
                  label="Verdicts"
                  value={
                    <span className="tabular-nums">
                      {passCount + failCount + maybeCount}
                    </span>
                  }
                >
                  <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                    <span>pass {passCount}</span>
                    <span>fail {failCount}</span>
                    <span>maybe {maybeCount}</span>
                  </div>
                </SummaryTile>
              </div>
            )
          })()}

          {!hasEvaluationData && (
            <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
              No evaluations captured for this session.
            </div>
          )}

          {evaluations.length > 0 && (
            <section className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ListChecks size={14} />
                Judge results
              </div>
              <EvaluationsAccordion evaluations={evaluations} />
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
