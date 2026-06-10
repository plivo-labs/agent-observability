import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDate } from '@/lib/observability-format'
import { alertsApi, type AlertFiring, type AlertRule, type WebhookAttempt } from '@/lib/alerts-api'
import { triggerSummary } from '@/lib/alerts-format'

type BadgeVariant = React.ComponentProps<typeof Badge>['variant']

const FIRING_STATUS_VARIANT: Record<string, BadgeVariant> = {
  delivered: 'ok',
  failed: 'err',
}

export const FiringStatusBadge = ({ status }: { status: string }) => (
  <Badge variant={FIRING_STATUS_VARIANT[status] ?? 'warn'}>{status}</Badge>
)

export const AlertFiringsDrawer = ({
  rule,
  onClose,
}: {
  rule: AlertRule | null
  onClose: () => void
}) => {
  const [firings, setFirings] = useState<AlertFiring[] | null>(null)
  const [attempts, setAttempts] = useState<WebhookAttempt[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!rule) return
    let cancelled = false
    setFirings(null)
    setAttempts(null)
    setError(null)
    Promise.all([alertsApi.listFirings(rule.id), alertsApi.listAttempts(rule.id)])
      .then(([f, a]) => {
        if (cancelled) return
        setFirings(f.objects)
        setAttempts(a.objects)
      })
      .catch((e) => {
        if (cancelled) return
        setFirings([])
        setAttempts([])
        setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [rule])

  return (
    <Sheet open={rule != null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{rule?.name}</SheetTitle>
          <SheetDescription>{rule ? triggerSummary(rule) : ''}</SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 pb-6">
          {error && (
            <div role="alert" className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
              Failed to load history: {error}
            </div>
          )}

          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Firings
            </div>
            {firings == null ? (
              <Skeleton className="h-16" />
            ) : firings.length === 0 ? (
              <div className="text-sm text-muted-foreground">Never fired.</div>
            ) : (
              <div className="space-y-2">
                {firings.map((f) => (
                  <div key={f.id} className="border bg-card p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <FiringStatusBadge status={f.status} />
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {formatDate(f.created_at)}
                      </span>
                    </div>
                    <div className="mt-1.5 text-muted-foreground">
                      {f.pass_rate != null
                        ? `pass rate ${Math.round(f.pass_rate * 100)}% (${f.matched_count}/${f.total_count})`
                        : `${f.matched_count} matching event${f.matched_count === 1 ? '' : 's'}`}
                      {' · '}
                      {f.attempt_count} attempt{f.attempt_count === 1 ? '' : 's'}
                      {f.response_status != null && ` · HTTP ${f.response_status}`}
                    </div>
                    {f.last_error && f.status !== 'delivered' && (
                      <div className="mt-1 font-mono text-[11px] text-destructive">{f.last_error}</div>
                    )}
                    {f.sample_session_ids.length > 0 && (
                      <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                        {f.sample_session_ids.slice(0, 4).join(', ')}
                        {f.sample_session_ids.length > 4 && ` +${f.sample_session_ids.length - 4}`}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Webhook attempts
            </div>
            {attempts == null ? (
              <Skeleton className="h-16" />
            ) : attempts.length === 0 ? (
              <div className="text-sm text-muted-foreground">No webhooks sent yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-[11px] text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">When</th>
                    <th className="py-1 pr-2 font-medium">Kind</th>
                    <th className="py-1 pr-2 text-right font-medium">#</th>
                    <th className="py-1 pr-2 text-right font-medium">Status</th>
                    <th className="py-1 text-right font-medium">ms</th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.map((a) => (
                    <tr key={a.id} className="border-b last:border-0">
                      <td className="py-1 pr-2 font-mono text-[11px] text-muted-foreground">
                        {formatDate(a.created_at)}
                      </td>
                      <td className="py-1 pr-2">
                        <Badge variant={a.kind === 'test' ? 'neutral' : 'secondary'}>{a.kind}</Badge>
                      </td>
                      <td className="py-1 pr-2 text-right tabular-nums">{a.attempt_number}</td>
                      <td
                        className={
                          'py-1 pr-2 text-right font-mono text-[11px] tabular-nums ' +
                          (a.ok ? 'text-[hsl(var(--success-fg))]' : 'text-destructive')
                        }
                      >
                        {a.response_status ?? a.error?.slice(0, 18) ?? '—'}
                      </td>
                      <td className="py-1 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                        {a.duration_ms ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}
