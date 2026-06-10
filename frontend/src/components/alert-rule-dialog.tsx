import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
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
  alertsApi,
  type AlertMetric,
  type AlertRule,
  type AlertRuleCreate,
  type AlertTriggerType,
} from '@/lib/alerts-api'
import { METRIC_LABEL, metricKind, WINDOW_OPTIONS } from '@/lib/alerts-format'

// Form model. threshold_input holds the value in the metric's NATIVE UI
// unit — percent integer for rates (converted to a 0–1 fraction on save),
// milliseconds for latency.
const EMPTY_FORM = {
  name: '',
  // Metric threshold is the headline trigger — open with the full metric
  // dropdown visible instead of hiding it behind a trigger switch.
  trigger_type: 'metric_threshold' as AlertTriggerType,
  metric: 'eval_fail_rate' as AlertMetric,
  judge_name: '',
  verdicts: ['fail'] as string[],
  threshold_count: 5,
  threshold_input: 30,
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

function thresholdToInput(metric: AlertMetric, value: number | null): number {
  if (value == null) return 30
  return metricKind(metric) === 'rate' ? Math.round(value * 100) : value
}

function formFromRule(rule: AlertRule): FormState {
  const metric = rule.metric ?? 'eval_fail_rate'
  return {
    name: rule.name,
    trigger_type: rule.trigger_type,
    metric,
    judge_name: rule.judge_name ?? '',
    verdicts: rule.verdicts,
    threshold_count: rule.threshold_count ?? 5,
    threshold_input: thresholdToInput(metric, rule.threshold_value),
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

/** Where judge_name is a meaningful filter — mirrors the server schema. */
function judgeApplies(form: FormState): boolean {
  if (form.trigger_type === 'evaluation_count') return true
  return form.trigger_type === 'metric_threshold' && form.metric === 'eval_fail_rate'
}

function inputFromForm(form: FormState): AlertRuleCreate {
  const headers = Object.fromEntries(
    form.headerRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]),
  )
  const isMetric = form.trigger_type === 'metric_threshold'
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    trigger_type: form.trigger_type,
    metric: isMetric ? form.metric : null,
    judge_name: judgeApplies(form) && form.judge_name.trim() ? form.judge_name.trim() : null,
    verdicts: form.verdicts,
    threshold_count: isMetric ? null : form.threshold_count,
    threshold_value: isMetric
      ? metricKind(form.metric) === 'rate'
        ? form.threshold_input / 100
        : form.threshold_input
      : null,
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
  metric_threshold: [],
}

const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <Label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
    {children}
  </Label>
)

export const AlertRuleDialog = ({
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

  const isMetric = form.trigger_type === 'metric_threshold'
  const kind = metricKind(form.metric)
  const verdictChoices = VERDICT_CHOICES[form.trigger_type]

  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      const input = inputFromForm(form)
      if (editing) await alertsApi.updateRule(editing.id, input)
      else await alertsApi.createRule(input)
      onSaved()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const submitDisabled =
    saving ||
    !form.name.trim() ||
    !form.webhook_url.trim() ||
    (!isMetric && form.verdicts.length === 0)

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
                  if (t !== 'metric_threshold') set('verdicts', ['fail'])
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="metric_threshold">Metric threshold</SelectItem>
                  <SelectItem value="evaluation_count">Eval verdict count</SelectItem>
                  <SelectItem value="outcome_count">Outcome count</SelectItem>
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

          {isMetric && (
            <div>
              <FieldLabel>Metric</FieldLabel>
              <Select
                value={form.metric}
                onValueChange={(v) => {
                  const m = v as AlertMetric
                  set('metric', m)
                  // Reset the threshold to a sensible default in the new unit.
                  set('threshold_input', metricKind(m) === 'rate' ? 30 : 2000)
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(METRIC_LABEL) as AlertMetric[]).map((m) => (
                    <SelectItem key={m} value={m}>
                      {METRIC_LABEL[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {judgeApplies(form) && (
            <div>
              <FieldLabel>Judge name (blank = any judge)</FieldLabel>
              <Input
                value={form.judge_name}
                onChange={(e) => set('judge_name', e.target.value)}
                placeholder="task_completion"
              />
            </div>
          )}

          {!isMetric && (
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
                        onClick={() => {
                          const next = active
                            ? form.verdicts.filter((x) => x !== v)
                            : [...form.verdicts, v]
                          // A rule must match at least one verdict — keep
                          // the last chip selected.
                          if (next.length > 0) set('verdicts', next)
                        }}
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

          {isMetric && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel>{kind === 'rate' ? 'Fire when above (%)' : 'Fire when above (ms)'}</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  max={kind === 'rate' ? 100 : undefined}
                  value={form.threshold_input}
                  onChange={(e) => {
                    const n = Math.max(1, Number(e.target.value) || 1)
                    set('threshold_input', kind === 'rate' ? Math.min(100, n) : n)
                  }}
                />
              </div>
              <div>
                <FieldLabel>Minimum samples in window</FieldLabel>
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
          <Button onClick={submit} disabled={submitDisabled}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
