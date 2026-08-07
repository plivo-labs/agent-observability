import { useEffect, useState } from 'react'
import { Gavel } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDate } from '@/lib/observability-format'
import { supervisorApi, type SupervisorAxisSummary } from '@/lib/supervisor-api'

/** Top-level supervisor view: one row per judge axis, showing how many of
 *  its verdicts the supervisor reviewed and how many it flagged as misflags
 *  (the supervisor disagreed with the judge). Sorted misflags-desc server-
 *  side. Clicking a row drills into that judge's misflagged cases. */
export const SupervisorPage = ({
  onAxisClick,
}: {
  onAxisClick?: (axis: string) => void
}) => {
  const [axes, setAxes] = useState<SupervisorAxisSummary[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    supervisorApi
      .listAxes()
      .then((r) => !cancelled && setAxes(r.objects))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="space-y-4">
      <div>
        <h1 className="m-0 text-lg font-semibold">Supervisor</h1>
        <div className="text-sm text-muted-foreground">
          A second-pass reviewer that re-judges evaluation verdicts. A misflag is
          a case where the supervisor disagreed with the judge — an over-fire or a
          missed problem.
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-border bg-muted px-4 py-2.5 text-sm">
          {error}
        </div>
      )}

      {loading || axes == null ? (
        <Skeleton className="h-48" />
      ) : axes.length === 0 ? (
        <div className="rounded-lg border bg-card p-10 text-center">
          <Gavel className="mx-auto mb-3 text-muted-foreground" size={22} strokeWidth={1.5} />
          <div className="text-sm font-medium">No supervisor reviews yet</div>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Once the supervisor re-judges evaluation verdicts, each judge axis will
            appear here with its misflag count.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Judge</th>
                <th className="px-2 py-2.5 font-medium">Review outcome</th>
                <th className="px-4 py-2.5 text-right font-medium">Last reviewed</th>
              </tr>
            </thead>
            <tbody>
              {axes.map((a) => (
                <tr
                  key={a.axis}
                  className="cursor-pointer border-b align-middle last:border-0 hover:bg-muted/40"
                  onClick={() => onAxisClick?.(a.axis)}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium hover:underline">{a.label}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      {a.axis}
                    </div>
                  </td>
                  <td className="px-2 py-3">
                    <div className="flex items-center gap-2">
                      <Badge variant={a.misflags > 0 ? 'err' : 'neutral'}>
                        {a.misflags} {a.misflags === 1 ? 'misflag' : 'misflags'}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground">
                        / {a.reviewed} reviewed
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[11px] text-muted-foreground">
                    {a.last_at ? formatDate(a.last_at) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
