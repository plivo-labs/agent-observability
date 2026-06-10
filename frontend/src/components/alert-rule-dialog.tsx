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
} from '@/lib/alerts-api'
import { METRIC_LABEL, metricKind, WINDOW_OPTIONS } from '@/lib/alerts-format'

// Form model. threshold_input holds the value in the metric's NATIVE UI
// unit — percent integer for rates (converted to a 0–1 fraction on save),
// milliseconds for latency.
const EMPTY_FORM = {
  name: '',
  metric: 'eval_fail_rate' as AlertMetric,
  judge_name: '',
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
  if (value == null) return metricKind(metric) === 'rate' ? 30 : 2000
  return metricKind(metric) === 'rate' ? Math.round(value * 100) : value
}

function formFromRule(rule: AlertRule): FormState {
  return {
    name: rule.name,
    metric: rule.metric,
    judge_name: rule.judge_name ?? '',
    threshold_input: thresholdToInput(rule.metric, rule.threshold_value),
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

/** judge_name only filters the eval_fail_rate metric — mirrors the server. */
function judgeApplies(metric: AlertMetric): boolean {
  return metric === 'eval_fail_rate'
}

function inputFromForm(form: FormState): AlertRuleCreate {
  const headers = Object.fromEntries(
    form.headerRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]),
  )
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    metric: form.metric,
    judge_name: judgeApplies(form.metric) && form.judge_name.trim() ? form.judge_name.trim() : null,
    threshold_value:
      metricKind(form.metric) === 'rate' ? form.threshold_input / 100 : form.threshold_input,
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

  const kind = metricKind(form.metric)

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

  const submitDisabled = saving || !form.name.trim() || !form.webhook_url.trim()

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && !o && onClose()}>
      {/* Flex column with a fixed header/footer and a scrollable middle, so
       * the action buttons stay pinned instead of scrolling off-screen on
       * short viewports. */}
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit alert rule' : 'New alert rule'}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 overflow-y-auto py-4">
          <div>
            <FieldLabel>Name</FieldLabel>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Fail spike — support bot" />
          </div>

          <div className="grid grid-cols-2 gap-3">
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

          {judgeApplies(form.metric) && (
            <div>
              <FieldLabel>Judge name (blank = any judge)</FieldLabel>
              <Input
                value={form.judge_name}
                onChange={(e) => set('judge_name', e.target.value)}
                placeholder="task_completion"
              />
            </div>
          )}

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

        <DialogFooter className="border-t pt-4">
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
