import { useCallback, useEffect, useMemo, useState } from 'react'
import { BellRing, Plus, Send, Trash2, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { KpiTile } from '@/components/kpi'
import { formatDate } from '@/lib/observability-format'
import {
  createAlertsApi,
  type AlertFiring,
  type AlertRule,
  type AlertRuleInput,
  type AlertTriggerType,
  type WebhookAttempt,
  type WebhookStats,
} from '@/lib/alerts-api'

const api = createAlertsApi('/api')

const TRIGGER_LABEL: Record<AlertTriggerType, string> = {
  evaluation_count: 'Eval verdicts',
  outcome_count: 'Outcomes',
  pass_rate: 'Pass rate',
}

const WINDOW_OPTIONS = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 240, label: '4 hours' },
  { minutes: 1440, label: '24 hours' },
]

function windowLabel(minutes: number): string {
  return WINDOW_OPTIONS.find((w) => w.minutes === minutes)?.label ?? `${minutes}m`
}

/** Human summary of the trigger condition — the table's load-bearing cell. */
function triggerSummary(rule: AlertRule): string {
  if (rule.trigger_type === 'pass_rate') {
    const pct = rule.threshold_pass_rate != null ? Math.round(rule.threshold_pass_rate * 100) : '?'
    const judge = rule.judge_name ? ` · ${rule.judge_name}` : ''
    return `< ${pct}% pass over ${windowLabel(rule.window_minutes)} (min ${rule.min_samples})${judge}`
  }
  const what = rule.verdicts.join('/')
  const judge = rule.trigger_type === 'evaluation_count' && rule.judge_name ? ` · ${rule.judge_name}` : ''
  return `≥ ${rule.threshold_count ?? '?'} ${what} in ${windowLabel(rule.window_minutes)}${judge}`
}

function formatPct(value: number | null | undefined): string {
  if (value == null) return '—'
  return `${Math.round(value * 100)}%`
}

// ── Rule form dialog ─────────────────────────────────────────────────────────

const EMPTY_FORM = {
  name: '',
  trigger_type: 'evaluation_count' as AlertTriggerType,
  judge_name: '',
  verdicts: ['fail'] as string[],
  threshold_count: 5,
  threshold_pass_rate: 80,
  min_samples: 5,
  window_minutes: 15,
  agent_id: '',
  account_id: '',
  webhook_url: '',
  http_method: 'POST' as 'POST' | 'PUT' | 'PATCH',
  secret: '',
  headerRows: [] as Array<{ key: string; value: string }>,
  enabled: true,
}

type FormState = typeof EMPTY_FORM

function formFromRule(rule: AlertRule): FormState {
  return {
    name: rule.name,
    trigger_type: rule.trigger_type,
    judge_name: rule.judge_name ?? '',
    verdicts: rule.verdicts,
    threshold_count: rule.threshold_count ?? 5,
    threshold_pass_rate: rule.threshold_pass_rate != null ? Math.round(rule.threshold_pass_rate * 100) : 80,
    min_samples: rule.min_samples,
    window_minutes: rule.window_minutes,
    agent_id: rule.agent_id ?? '',
    account_id: rule.account_id ?? '',
    webhook_url: rule.webhook_url,
    http_method: rule.http_method,
    secret: rule.secret ?? '',
    headerRows: Object.entries(rule.headers ?? {}).map(([key, value]) => ({ key, value })),
    enabled: rule.enabled,
  }
}

function inputFromForm(form: FormState): AlertRuleInput {
  const headers = Object.fromEntries(
    form.headerRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]),
  )
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    trigger_type: form.trigger_type,
    judge_name: form.trigger_type !== 'outcome_count' && form.judge_name.trim() ? form.judge_name.trim() : null,
    verdicts: form.verdicts,
    threshold_count: form.trigger_type === 'pass_rate' ? null : form.threshold_count,
    threshold_pass_rate: form.trigger_type === 'pass_rate' ? form.threshold_pass_rate / 100 : null,
    min_samples: form.min_samples,
    window_minutes: form.window_minutes,
    agent_id: form.agent_id.trim() || null,
    account_id: form.account_id.trim() || null,
    webhook_url: form.webhook_url.trim(),
    http_method: form.http_method,
    secret: form.secret.trim() || null,
    headers: Object.keys(headers).length ? headers : null,
  }
}

const VERDICT_CHOICES: Record<AlertTriggerType, string[]> = {
  evaluation_count: ['pass', 'fail', 'maybe'],
  outcome_count: ['success', 'fail'],
  pass_rate: [],
}

const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <Label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
    {children}
  </Label>
)

const RuleDialog = ({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean
  editing: AlertRule | null
  onClose: () => void
  onSaved: () => void
}) => {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setForm(editing ? formFromRule(editing) : EMPTY_FORM)
      setError(null)
    }
  }, [open, editing])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const isPassRate = form.trigger_type === 'pass_rate'
  const verdictChoices = VERDICT_CHOICES[form.trigger_type]

  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      const input = inputFromForm(form)
      if (editing) await api.updateRule(editing.id, input)
      else await api.createRule(input)
      onSaved()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit alert rule' : 'New alert rule'}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4">
          <div>
            <FieldLabel>Name</FieldLabel>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Fail spike — support bot" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel>Trigger</FieldLabel>
              <Select
                value={form.trigger_type}
                onValueChange={(v) => {
                  const t = v as AlertTriggerType
                  set('trigger_type', t)
                  if (t === 'outcome_count') set('verdicts', ['fail'])
                  if (t === 'evaluation_count') set('verdicts', ['fail'])
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="evaluation_count">Eval verdict count</SelectItem>
                  <SelectItem value="outcome_count">Outcome count</SelectItem>
                  <SelectItem value="pass_rate">Eval pass rate</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <FieldLabel>Window</FieldLabel>
              <Select
                value={String(form.window_minutes)}
                onValueChange={(v) => set('window_minutes', Number(v))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WINDOW_OPTIONS.map((w) => (
                    <SelectItem key={w.minutes} value={String(w.minutes)}>
                      {w.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {form.trigger_type !== 'outcome_count' && (
            <div>
              <FieldLabel>Judge name (blank = any judge)</FieldLabel>
              <Input
                value={form.judge_name}
                onChange={(e) => set('judge_name', e.target.value)}
                placeholder="task_completion"
              />
            </div>
          )}

          {!isPassRate && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel>Threshold (count ≥)</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  value={form.threshold_count}
                  onChange={(e) => set('threshold_count', Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
              <div>
                <FieldLabel>Match verdicts</FieldLabel>
                <div className="flex h-9 items-center gap-2">
                  {verdictChoices.map((v) => {
                    const active = form.verdicts.includes(v)
                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() =>
                          set(
                            'verdicts',
                            active
                              ? form.verdicts.filter((x) => x !== v)
                              : [...form.verdicts, v],
                          )
                        }
                        className={
                          'border px-2 py-0.5 font-mono text-[11px] transition-colors ' +
                          (active
                            ? 'border-foreground bg-foreground text-background'
                            : 'border-border text-muted-foreground hover:text-foreground')
                        }
                      >
                        {v}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {isPassRate && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel>Fire when pass rate below (%)</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={form.threshold_pass_rate}
                  onChange={(e) =>
                    set('threshold_pass_rate', Math.min(100, Math.max(1, Number(e.target.value) || 1)))
                  }
                />
              </div>
              <div>
                <FieldLabel>Minimum evaluations</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  value={form.min_samples}
                  onChange={(e) => set('min_samples', Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel>Agent id (blank = any)</FieldLabel>
              <Input value={form.agent_id} onChange={(e) => set('agent_id', e.target.value)} />
            </div>
            <div>
              <FieldLabel>Account id (blank = any)</FieldLabel>
              <Input value={form.account_id} onChange={(e) => set('account_id', e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-[110px_1fr] gap-3">
            <div>
              <FieldLabel>Method</FieldLabel>
              <Select value={form.http_method} onValueChange={(v) => set('http_method', v as FormState['http_method'])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="POST">POST</SelectItem>
                  <SelectItem value="PUT">PUT</SelectItem>
                  <SelectItem value="PATCH">PATCH</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <FieldLabel>Webhook URL</FieldLabel>
              <Input
                value={form.webhook_url}
                onChange={(e) => set('webhook_url', e.target.value)}
                placeholder="https://hooks.example.com/alerts"
              />
            </div>
          </div>

          <div>
            <FieldLabel>Signing secret (optional — sends x-alert-signature)</FieldLabel>
            <Input value={form.secret} onChange={(e) => set('secret', e.target.value)} />
          </div>

          <div>
            <FieldLabel>Custom headers</FieldLabel>
            <div className="space-y-2">
              {form.headerRows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    className="flex-1"
                    placeholder="x-header-name"
                    value={row.key}
                    onChange={(e) => {
                      const rows = [...form.headerRows]
                      rows[i] = { ...rows[i], key: e.target.value }
                      set('headerRows', rows)
                    }}
                  />
                  <Input
                    className="flex-[2]"
                    placeholder="value"
                    value={row.value}
                    onChange={(e) => {
                      const rows = [...form.headerRows]
                      rows[i] = { ...rows[i], value: e.target.value }
                      set('headerRows', rows)
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => set('headerRows', form.headerRows.filter((_, j) => j !== i))}
                  >
                    <X size={14} />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => set('headerRows', [...form.headerRows, { key: '', value: '' }])}
              >
                <Plus size={13} /> Add header
              </Button>
            </div>
          </div>

          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !form.name.trim() || !form.webhook_url.trim()}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Firings drawer ───────────────────────────────────────────────────────────

const StatusBadge = ({ status }: { status: string }) => {
  const variant = status === 'delivered' ? 'ok' : status === 'failed' ? 'err' : 'warn'
  return <Badge variant={variant as any}>{status}</Badge>
}

const FiringsDrawer = ({ rule, onClose }: { rule: AlertRule | null; onClose: () => void }) => {
  const [firings, setFirings] = useState<AlertFiring[] | null>(null)
  const [attempts, setAttempts] = useState<WebhookAttempt[] | null>(null)

  useEffect(() => {
    if (!rule) return
    setFirings(null)
    setAttempts(null)
    api.listFirings(rule.id).then((r) => setFirings(r.objects)).catch(() => setFirings([]))
    api.listAttempts(rule.id).then((r) => setAttempts(r.objects)).catch(() => setAttempts([]))
  }, [rule])

  return (
    <Sheet open={rule != null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{rule?.name}</SheetTitle>
          <SheetDescription>{rule ? triggerSummary(rule) : ''}</SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 pb-6">
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
                      <StatusBadge status={f.status} />
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

// ── Page ─────────────────────────────────────────────────────────────────────

export const AlertRulesPage = () => {
  const [rules, setRules] = useState<AlertRule[] | null>(null)
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
    api
      .listRules()
      .then((r) => !cancelled && setRules(r.objects))
      .catch((e) => !cancelled && setError(e.message))
    api
      .webhookStats('7d')
      .then((s) => !cancelled && setStats(s))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [tick])

  const toggleEnabled = async (rule: AlertRule) => {
    try {
      await api.updateRule(rule.id, { enabled: !rule.enabled })
      refetch()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const runTest = async (rule: AlertRule) => {
    setTestResult({ id: rule.id, text: 'sending…', ok: true })
    try {
      const r = await api.testRule(rule.id)
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
      await api.deleteRule(deleting.id)
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
          value={formatPct(stats?.acceptance_rate)}
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

      {rules == null ? (
        <Skeleton className="h-48" />
      ) : rules.length === 0 ? (
        <div className="rounded-lg border bg-card p-10 text-center">
          <BellRing className="mx-auto mb-3 text-muted-foreground" size={22} strokeWidth={1.5} />
          <div className="text-sm font-medium">No alert rules yet</div>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Watch conversation evals for verdict spikes or pass-rate drops and get a webhook when a
            threshold trips.
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
                <tr key={rule.id} className="border-b align-top last:border-0 hover:bg-muted/40">
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
                    <Badge variant="secondary">{TRIGGER_LABEL[rule.trigger_type]}</Badge>
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

      <RuleDialog
        open={dialogOpen}
        editing={editing}
        onClose={() => setDialogOpen(false)}
        onSaved={refetch}
      />
      <FiringsDrawer rule={drawerRule} onClose={() => setDrawerRule(null)} />

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
