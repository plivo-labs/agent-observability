import { useEffect, useState } from 'react'
import { ArrowLeft, Gavel } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDate } from '@/lib/observability-format'
import {
  supervisorApi,
  type SuggestedFix,
  type SupervisorAxisDetail,
  type SupervisorCase,
  type SupervisorVerdict,
} from '@/lib/supervisor-api'

/** flagged reads as a problem (red), clear as fine (green). */
const verdictVariant = (v: SupervisorVerdict) => (v === 'flagged' ? 'err' : 'ok')

/** A suggested_fix is meaningful only if it actually proposes something —
 *  the API sometimes returns a present-but-empty object. */
const hasFix = (fix: SuggestedFix | null): fix is SuggestedFix =>
  !!fix && (fix.add.length > 0 || fix.remove.length > 0 || fix.rationale.trim().length > 0)

/** Classify a misflag: over-fire = judge flagged, supervisor cleared;
 *  missed = judge cleared, supervisor flagged. */
function misflagKind(c: SupervisorCase): { label: string; variant: 'warn' | 'err' } | null {
  if (c.original_verdict === 'flagged' && c.supervisor_verdict === 'clear') {
    return { label: 'Over-fire', variant: 'warn' }
  }
  if (c.original_verdict === 'clear' && c.supervisor_verdict === 'flagged') {
    return { label: 'Missed', variant: 'err' }
  }
  return null
}

function VerdictLine({
  who,
  verdict,
  reason,
  votes,
}: {
  who: string
  verdict: SupervisorVerdict
  reason: string
  votes?: string
}) {
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{who}</span>
        <Badge variant={verdictVariant(verdict)}>{verdict}</Badge>
        {votes && <span className="text-[11px] text-muted-foreground">{votes}</span>}
      </div>
      <p className="text-sm text-muted-foreground">{reason || '—'}</p>
    </div>
  )
}

function SuggestedFixBlock({ fix }: { fix: SuggestedFix | null }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <div className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        Suggested prompt fix
      </div>
      {!hasFix(fix) ? (
        <span className="text-sm text-muted-foreground">No fix suggested.</span>
      ) : (
        <div className="space-y-2">
          {fix.add.length > 0 && (
            <div>
              <div className="mb-1 font-mono text-[11px] font-semibold text-success-fg">
                + add to prompt
              </div>
              <div className="space-y-1">
                {fix.add.map((line, i) => (
                  <div key={`add-${i}`} className="flex gap-2 text-sm">
                    <span className="select-none font-mono text-success-fg">+</span>
                    <span>{line}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {fix.remove.length > 0 && (
            <div>
              <div className="mb-1 font-mono text-[11px] font-semibold text-destructive">
                − remove from prompt
              </div>
              <div className="space-y-1">
                {fix.remove.map((line, i) => (
                  <div key={`rem-${i}`} className="flex gap-2 text-sm">
                    <span className="select-none font-mono text-destructive">−</span>
                    <span>{line}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {fix.rationale.trim() && (
            <p className="border-t border-border pt-2 text-[13px] text-muted-foreground">
              {fix.rationale}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** Drill-down for one judge axis: its misflagged cases and the prompt fixes
 *  the supervisor suggested for each. */
export const SupervisorAxisPage = ({
  axis,
  onBack,
}: {
  axis: string
  onBack: () => void
}) => {
  const [detail, setDetail] = useState<SupervisorAxisDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    supervisorApi
      .getAxis(axis)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [axis])

  const cases = detail?.objects ?? []

  return (
    <div className="space-y-4">
      <div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} /> Supervisor
        </button>
        <div className="mt-1 flex flex-wrap items-baseline gap-2">
          <h1 className="m-0 text-lg font-semibold">{detail?.label ?? axis}</h1>
          <span className="font-mono text-[11px] text-muted-foreground">{axis}</span>
          {!loading && (
            <span className="text-sm text-muted-foreground">
              {cases.length} {cases.length === 1 ? 'misflag' : 'misflags'}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-border bg-muted px-4 py-2.5 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <Skeleton className="h-48" />
      ) : cases.length === 0 ? (
        <div className="rounded-lg border bg-card p-10 text-center">
          <Gavel className="mx-auto mb-3 text-muted-foreground" size={22} strokeWidth={1.5} />
          <div className="text-sm font-medium">No misflags for this judge</div>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            The supervisor reviewed this judge's verdicts and agreed with all of them.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {cases.map((c, i) => {
            const kind = misflagKind(c)
            return (
              <Card key={`${c.session_id}-${c.node_ref ?? i}`} size="sm">
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[13px]">{c.session_id.slice(0, 8)}</span>
                    {c.node_name && (
                      <span className="text-sm font-normal text-muted-foreground">
                        · {c.node_name}
                      </span>
                    )}
                  </CardTitle>
                  <CardAction>
                    {kind ? (
                      <Badge variant={kind.variant}>{kind.label}</Badge>
                    ) : (
                      <Badge variant="neutral">misflag</Badge>
                    )}
                  </CardAction>
                </CardHeader>
                <CardContent className="space-y-3">
                  <VerdictLine who="Judge" verdict={c.original_verdict} reason={c.original_reason} />
                  <VerdictLine
                    who="Supervisor"
                    verdict={c.supervisor_verdict}
                    reason={c.supervisor_reason}
                    votes={`${c.votes_for}/${c.votes_total} votes`}
                  />
                  <SuggestedFixBlock fix={c.suggested_fix} />
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{c.supervisor_model}</span>
                    <span>observed {formatDate(c.observed_at)}</span>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
