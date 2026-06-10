import { useCallback, useEffect, useMemo, useState } from 'react'
import { BellRing, Plus, Send, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { KpiTile } from '@/components/kpi'
import { formatDate, formatPercent } from '@/lib/observability-format'
import { alertsApi, type AlertRule, type WebhookStats } from '@/lib/alerts-api'
import { METRIC_LABEL, triggerSummary } from '@/lib/alerts-format'
import { AlertRuleDialog } from '@/components/alert-rule-dialog'
import { AlertFiringsDrawer } from '@/components/alert-firings-drawer'

export const AlertRulesPage = () => {
  const [rules, setRules] = useState<AlertRule[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<WebhookStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AlertRule | null>(null)
  const [drawerRule, setDrawerRule] = useState<AlertRule | null>(null)
  const [deleting, setDeleting] = useState<AlertRule | null>(null)
  const [testResult, setTestResult] = useState<{ id: string; text: string; ok: boolean } | null>(null)
  const [tick, setTick] = useState(0)

  const refetch = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    alertsApi
      .listRules()
      .then((r) => !cancelled && setRules(r.objects))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    alertsApi
      .webhookStats('7d')
      .then((s) => !cancelled && setStats(s))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [tick])

  const toggleEnabled = async (rule: AlertRule) => {
    try {
      await alertsApi.updateRule(rule.id, { enabled: !rule.enabled })
      refetch()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const runTest = async (rule: AlertRule) => {
    setTestResult({ id: rule.id, text: 'sending…', ok: true })
    try {
      const r = await alertsApi.testRule(rule.id)
      setTestResult({
        id: rule.id,
        text: r.ok ? `HTTP ${r.response_status} · ${r.duration_ms}ms` : r.error ?? 'failed',
        ok: r.ok,
      })
    } catch (e) {
      setTestResult({ id: rule.id, text: (e as Error).message, ok: false })
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await alertsApi.deleteRule(deleting.id)
      setDeleting(null)
      refetch()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const activeRules = useMemo(() => rules?.filter((r) => r.enabled).length ?? 0, [rules])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Alerts</h1>
        <div className="flex-1" />
        <Button onClick={() => { setEditing(null); setDialogOpen(true) }}>
          <Plus size={14} /> New rule
        </Button>
      </div>

      <div className="eval-kpi-grid">
        <KpiTile
          label="Rules"
          value={rules ? String(rules.length) : '—'}
          sub={`${activeRules} enabled`}
        />
        <KpiTile
          label="Webhooks sent · 7d"
          value={stats ? String(stats.total_attempts) : '—'}
          sub={stats ? `${stats.accepted} accepted` : undefined}
          sparkValues={stats?.buckets.map((b) => b.attempts)}
          sparkColor="hsl(270 60% 55%)"
        />
        <KpiTile
          label="Acceptance rate"
          value={formatPercent(stats?.acceptance_rate)}
          sub="2xx responses"
          barPct={stats?.acceptance_rate != null ? stats.acceptance_rate * 100 : undefined}
          barVariant={
            stats?.acceptance_rate == null
              ? undefined
              : stats.acceptance_rate >= 0.95
                ? 'pass'
                : stats.acceptance_rate >= 0.7
                  ? 'warn'
                  : 'fail'
          }
        />
        <KpiTile
          label="Avg delivery"
          value={stats?.avg_duration_ms != null ? `${stats.avg_duration_ms} ms` : '—'}
          sub="webhook round-trip"
        />
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-border bg-muted px-4 py-2.5 text-sm">
          {error}
        </div>
      )}

      {loading || rules == null ? (
        <Skeleton className="h-48" />
      ) : rules.length === 0 ? (
        <div className="rounded-lg border bg-card p-10 text-center">
          <BellRing className="mx-auto mb-3 text-muted-foreground" size={22} strokeWidth={1.5} />
          <div className="text-sm font-medium">No alert rules yet</div>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Watch fail rates, latency, and interruptions over a window and get a webhook when a
            metric crosses its threshold.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Rule</th>
                <th className="px-2 py-2.5 font-medium">Condition</th>
                <th className="px-2 py-2.5 font-medium">Scope</th>
                <th className="px-2 py-2.5 font-medium">Webhook</th>
                <th className="px-2 py-2.5 font-medium">Last fired</th>
                <th className="px-4 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b align-middle last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      className="text-left font-medium hover:underline"
                      onClick={() => setDrawerRule(rule)}
                    >
                      {rule.name}
                    </button>
                    <div className="mt-0.5">
                      <button type="button" onClick={() => toggleEnabled(rule)} title="Toggle">
                        <Badge variant={rule.enabled ? 'ok' : 'neutral'}>
                          {rule.enabled ? 'enabled' : 'disabled'}
                        </Badge>
                      </button>
                    </div>
                  </td>
                  <td className="px-2 py-3">
                    <Badge variant="secondary">{METRIC_LABEL[rule.metric]}</Badge>
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {triggerSummary(rule)}
                    </div>
                  </td>
                  <td className="px-2 py-3 font-mono text-[11px] text-muted-foreground">
                    {rule.agent_id ?? 'any agent'}
                    <br />
                    {rule.account_id ?? 'any account'}
                  </td>
                  <td className="max-w-[200px] px-2 py-3">
                    <span className="font-mono text-[11px]">{rule.http_method}</span>
                    <div className="truncate font-mono text-[11px] text-muted-foreground" title={rule.webhook_url}>
                      {rule.webhook_url}
                    </div>
                    {testResult?.id === rule.id && (
                      <div
                        className={
                          'mt-0.5 font-mono text-[11px] ' +
                          (testResult.ok ? 'text-[hsl(var(--success-fg))]' : 'text-destructive')
                        }
                      >
                        {testResult.text}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-3 font-mono text-[11px] text-muted-foreground">
                    {rule.last_fired_at ? formatDate(rule.last_fired_at) : 'never'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" title="Send test webhook" onClick={() => runTest(rule)}>
                        <Send size={13} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setEditing(rule); setDialogOpen(true) }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Delete"
                        onClick={() => setDeleting(rule)}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AlertRuleDialog
        open={dialogOpen}
        editing={editing}
        onClose={() => setDialogOpen(false)}
        onSaved={refetch}
      />
      <AlertFiringsDrawer rule={drawerRule} onClose={() => setDrawerRule(null)} />

      <Dialog open={deleting != null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete “{deleting?.name}”?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The rule, its firing history, and its webhook audit trail will be removed.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
