/**
 * Side-drawer detail panel for one conversation-eval row.
 *
 * Top of the drawer mirrors the existing session-detail evaluations
 * sidebar (outcome chip, verdict counts). The judges list inside is
 * an Accordion — each judge result is its own AccordionItem with the
 * trigger showing `name · timestamp · pass/fail` and the expanded
 * body carrying the reasoning + instructions. Multiple type so
 * several judges can be inspected at once.
 *
 * Reuses ResultBadge + SummaryTile + EvaluationDetail from the
 * session-evaluations-drawer so the visual style stays identical to
 * the existing session-detail sidebar.
 */

import {
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  ExternalLink,
  ListChecks,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { formatDate, formatDuration } from '@/lib/observability-format'
import type {
  ConversationEvalSummary,
  SessionExternalEvaluation,
} from '@/lib/observability-types'
import {
  EvaluationsAccordion,
  ResultBadge,
  SummaryTile,
} from '@/components/session-evaluations-drawer'

interface ConversationEvalDetailDrawerProps {
  row: ConversationEvalSummary | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ConversationEvalDetailDrawer({
  row,
  open,
  onOpenChange,
}: ConversationEvalDetailDrawerProps) {
  const evaluations = (row?.evaluations ?? []) as SessionExternalEvaluation[]

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full overflow-y-auto p-0 sm:max-w-xl md:max-w-2xl"
        showCloseButton
      >
        <SheetHeader className="border-b px-5 py-4">
          {/* Title row holds the Open-session action on the right so
              it's the first thing in the drawer — easy reach without
              scrolling past the judge list. */}
          <div className="flex items-center justify-between gap-3">
            <SheetTitle className="flex items-center gap-2">
              <ClipboardCheck size={16} />
              Conversation eval
            </SheetTitle>
            {row && (
              // Anchor (not a callback) so the button picks up native
              // new-tab semantics: target="_blank", plus middle-click /
              // cmd-click / "Open in new tab" on right-click all work.
              // `mr-7` reserves space for the sheet's built-in close X
              // — without it the button collides with the close on
              // narrow viewports.
              <Button asChild variant="outline" size="sm" className="mr-7">
                <a
                  href={
                    row.agent_id
                      ? `/agents/${encodeURIComponent(row.agent_id)}/sessions/${row.session_id}`
                      : `/sessions/${row.session_id}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={14} />
                  Open session
                </a>
              </Button>
            )}
          </div>
          {row && (
            <SheetDescription className="space-y-0.5">
              <div className="text-xs text-foreground font-mono">
                {row.session_id}
              </div>
              <div className="text-xs">
                {formatDate(row.ended_at)}
                {row.duration_ms != null && (
                  <span> · {formatDuration(row.duration_ms)}</span>
                )}
                {row.account_id && (
                  <span>
                    {' · '}
                    <span className="font-mono">{row.account_id}</span>
                  </span>
                )}
              </div>
            </SheetDescription>
          )}
        </SheetHeader>

        {row && (
          <div className="flex flex-col gap-4 p-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <SummaryTile
                label="Outcome"
                value={
                  row.outcome ? (
                    <ResultBadge value={row.outcome.replace(/^lk\./, '')} />
                  ) : (
                    // Outcomes are an opt-in business signal the worker
                    // emits via tagger.outcome(); when absent, the
                    // session simply has no outcome — not a "pending"
                    // state machine. Match the table column's "—"
                    // treatment so the same nullable field reads the
                    // same way on both surfaces.
                    <span className="text-muted-foreground">—</span>
                  )
                }
              >
                {row.outcome_reason && (
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {row.outcome_reason}
                  </p>
                )}
              </SummaryTile>
              <SummaryTile
                label="Score"
                value={(() => {
                  // Mirrors LiveKit's EvaluationResult.score:
                  // pass_count / total verdicts, with maybe treated as
                  // not-passed (matches j.passed in JudgmentResult).
                  const total =
                    row.pass_count + row.fail_count + row.maybe_count
                  if (total === 0) {
                    return <span className="text-muted-foreground">—</span>
                  }
                  const pct = Math.round((row.pass_count / total) * 100)
                  const tone =
                    pct >= 90
                      ? 'text-success-fg'
                      : pct >= 60
                        ? 'text-warning-fg'
                        : 'text-destructive'
                  return (
                    <span className={`tabular-nums font-mono text-base ${tone}`}>
                      {pct}
                      <span className="text-xs ml-0.5">%</span>
                    </span>
                  )
                })()}
              >
                <div className="mt-2 flex items-center gap-3 text-xs leading-none text-muted-foreground">
                  {row.pass_count > 0 && (
                    <span className="inline-flex items-center gap-1" title="pass">
                      <CheckCircle2
                        size={12}
                        className="shrink-0 text-success-fg"
                      />
                      <span className="tabular-nums leading-none">
                        {row.pass_count}
                      </span>
                    </span>
                  )}
                  {row.fail_count > 0 && (
                    <span className="inline-flex items-center gap-1" title="fail">
                      <XCircle
                        size={12}
                        className="shrink-0 text-destructive"
                      />
                      <span className="tabular-nums leading-none">
                        {row.fail_count}
                      </span>
                    </span>
                  )}
                  {row.maybe_count > 0 && (
                    <span className="inline-flex items-center gap-1" title="maybe">
                      <CircleAlert
                        size={12}
                        className="shrink-0 text-warning-fg"
                      />
                      <span className="tabular-nums leading-none">
                        {row.maybe_count}
                      </span>
                    </span>
                  )}
                  <span>
                    across {evaluations.length} judge
                    {evaluations.length === 1 ? '' : 's'}
                  </span>
                </div>
              </SummaryTile>
            </div>

            {evaluations.length > 0 && (
              <section className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <ListChecks size={14} />
                  Judge results
                </div>

                <EvaluationsAccordion evaluations={evaluations} />
              </section>
            )}

            {evaluations.length === 0 && !row.outcome && (
              <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
                No eval data attached to this session.
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
