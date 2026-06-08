/* schedules-page.tsx — recurring scheduled evaluations + alerts.
 * A schedule runs a saved scenario on a cadence; alerts fire when pass-rate slips. */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { AlertTriangle, CalendarClock, Pause, Play, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { interval, rateTone, rel } from '@/lib/observability-format'

interface Schedule {
  id: string; name: string; scenario_id: string; interval_minutes: number; enabled: boolean
  alert_pass_rate: number | null; last_run_at: string | null; last_pass_rate: number | null
  last_eval_run_id: string | null; next_run_at: string
}
interface Scenario { id: string; name: string }
interface Alert { id: number; schedule_name: string; message: string; pass_rate: number | null; eval_run_id: string | null; created_at: string }

export function SchedulesPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState<Schedule[]>([])
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ name: '', scenario_id: '', interval_minutes: 60, alert_pass_rate: 80 })

  const load = () => {
    api<{ objects: Schedule[] }>('/api/schedules').then((d) => setItems(d.objects)).catch((e) => setErr(e.message))
    api<{ objects: Alert[] }>('/api/alerts').then((d) => setAlerts(d.objects)).catch(() => {})
  }
  useEffect(() => {
    load()
    api<{ objects: Scenario[] }>('/api/library/scenarios').then((d) => setScenarios(d.objects)).catch(() => {})
    const iv = setInterval(load, 12000) // poll so scheduled runs surface
    return () => clearInterval(iv)
  }, [])

  const create = async () => {
    try {
      await api('/api/schedules', { method: 'POST', body: JSON.stringify({ ...form, alert_pass_rate: form.alert_pass_rate || null }) })
      setOpen(false); setForm({ name: '', scenario_id: '', interval_minutes: 60, alert_pass_rate: 80 }); load()
    } catch (e) { setErr((e as Error).message) }
  }
  const toggle = (s: Schedule) => api(`/api/schedules/${s.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !s.enabled }) }).then(load).catch((e) => setErr(e.message))
  const runNow = (s: Schedule) => api(`/api/schedules/${s.id}/run`, { method: 'POST' }).then(load).catch((e) => setErr(e.message))
  const del = (s: Schedule) => { if (!confirm(`Delete schedule "${s.name}"?`)) return; api(`/api/schedules/${s.id}`, { method: 'DELETE' }).then(load).catch((e) => setErr(e.message)) }
  const scenarioName = (id: string) => scenarios.find((s) => s.id === id)?.name ?? id.slice(0, 8)

  return (
    <div className="animate-in fade-in duration-300">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold leading-8 text-foreground">Schedules</h1>
          <div className="mt-1 text-sm text-muted-foreground">Run a saved scenario on a cadence; get alerted when the pass-rate slips.</div>
        </div>
        <Button size="sm" onClick={() => { setErr(null); setOpen(true) }} disabled={scenarios.length === 0}><Plus size={14} /> New schedule</Button>
      </div>
      {err && <div className="mb-3 text-sm text-destructive">{err}</div>}
      {scenarios.length === 0 && <div className="mb-4 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">Create a Scenario in the Library first — schedules run a saved scenario.</div>}

      <div className="mb-6 rounded-lg border border-border bg-card">
        <Table>
          <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Scenario</TableHead><TableHead>Every</TableHead><TableHead>Last run</TableHead><TableHead>Pass rate</TableHead><TableHead>Next</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {items.length === 0 && <TableRow><TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">No schedules yet.</TableCell></TableRow>}
            {items.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">{s.name}{s.alert_pass_rate != null && <span className="ml-2 text-[11px] text-muted-foreground">alert &lt;{s.alert_pass_rate}%</span>}</TableCell>
                <TableCell className="text-muted-foreground">{scenarioName(s.scenario_id)}</TableCell>
                <TableCell className="tabular-nums">{interval(s.interval_minutes)}</TableCell>
                <TableCell className="text-muted-foreground">{rel(s.last_run_at)}</TableCell>
                <TableCell>{s.last_pass_rate == null ? <span className="text-muted-foreground">—</span> : <span className={cn('font-semibold tabular-nums', rateTone(s.last_pass_rate))}>{s.last_pass_rate}%</span>}</TableCell>
                <TableCell className="text-muted-foreground">{s.enabled ? rel(s.next_run_at) : '—'}</TableCell>
                <TableCell>{s.enabled ? <Badge variant="outline" className="text-success">active</Badge> : <Badge variant="outline" className="text-muted-foreground">paused</Badge>}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    {s.last_eval_run_id && <button title="Open last run" onClick={() => navigate(`/evals/${s.last_eval_run_id}`)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><CalendarClock size={15} /></button>}
                    <button title="Run now" onClick={() => runNow(s)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><Play size={15} /></button>
                    <button title={s.enabled ? 'Pause' : 'Resume'} onClick={() => toggle(s)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">{s.enabled ? <Pause size={15} /> : <Play size={15} />}</button>
                    <button title="Delete" onClick={() => del(s)} className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 size={15} /></button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground"><AlertTriangle size={16} className="text-warning" /> Recent alerts</div>
        {alerts.length === 0
          ? <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">No alerts — pass-rates are holding above their thresholds.</div>
          : <div className="flex flex-col gap-2">
              {alerts.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-4 rounded-lg border border-warning/30 bg-warning/8 px-3.5 py-2.5">
                  <div className="flex items-center gap-2.5 text-sm"><AlertTriangle size={15} className="shrink-0 text-warning" /><span className="text-foreground">{a.message}</span></div>
                  <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                    <span>{rel(a.created_at)}</span>
                    {a.eval_run_id && <button onClick={() => navigate(`/evals/${a.eval_run_id}`)} className="font-medium text-primary hover:underline">view run</button>}
                  </div>
                </div>
              ))}
            </div>}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New schedule</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Nightly guardrail check" /></div>
            <div><Label>Scenario</Label>
              <Select value={form.scenario_id} onValueChange={(v) => setForm({ ...form, scenario_id: v })}>
                <SelectTrigger><SelectValue placeholder="Pick a scenario" /></SelectTrigger>
                <SelectContent>{scenarios.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Every (minutes)</Label><Input type="number" min={1} value={form.interval_minutes} onChange={(e) => setForm({ ...form, interval_minutes: +e.target.value })} /></div>
              <div><Label>Alert if pass-rate &lt; (%)</Label><Input type="number" min={0} max={100} value={form.alert_pass_rate} onChange={(e) => setForm({ ...form, alert_pass_rate: +e.target.value })} /></div>
            </div>
            {err && <div className="text-sm text-destructive">{err}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={!form.name.trim() || !form.scenario_id}>Create schedule</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
