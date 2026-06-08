/* schedules-page.tsx — recurring scheduled evaluations + alerts.
 * A schedule runs a saved scenario on a cadence; alerts fire when pass-rate slips. */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Activity, AlertTriangle, BellRing, CalendarClock, Gauge, Pause, Play, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toneClass } from '@/lib/tone'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const PRIMARY_FG = { color: 'hsl(var(--primary-foreground))' } as const

interface Schedule {
  id: string; name: string; scenario_id: string; interval_minutes: number; enabled: boolean
  alert_pass_rate: number | null; last_run_at: string | null; last_pass_rate: number | null
  last_eval_run_id: string | null; next_run_at: string
}
interface Scenario { id: string; name: string }
interface Alert { id: number; schedule_name: string; message: string; pass_rate: number | null; eval_run_id: string | null; created_at: string }

async function api<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...opts })
  if (!res.ok) { let m = `Request failed (${res.status})`; try { m = (await res.json())?.error?.message ?? m } catch { /* ignore */ } throw new Error(m) }
  return res.json()
}

function rel(ts: string | null): string {
  if (!ts) return '—'
  const d = (Date.now() - new Date(ts).getTime()) / 1000
  const fmt = (n: number, u: string) => `${Math.round(n)}${u}`
  if (d < 0) {
    const a = -d
    return 'in ' + (a < 60 ? fmt(a, 's') : a < 3600 ? fmt(a / 60, 'm') : fmt(a / 3600, 'h'))
  }
  return (d < 60 ? fmt(d, 's') : d < 3600 ? fmt(d / 60, 'm') : d < 86400 ? fmt(d / 3600, 'h') : fmt(d / 86400, 'd')) + ' ago'
}
const interval = (m: number) => (m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`)
const rateTone = (r: number | null) => (r == null ? 'text-muted-foreground' : r >= 80 ? 'text-success' : r >= 50 ? 'text-warning' : 'text-destructive')

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

  const activeN = items.filter((s) => s.enabled).length
  const ratedItems = items.filter((s) => s.last_pass_rate != null)
  const avgRate = ratedItems.length ? Math.round(ratedItems.reduce((a, s) => a + (s.last_pass_rate ?? 0), 0) / ratedItems.length) : null
  const breaching = items.filter((s) => s.alert_pass_rate != null && s.last_pass_rate != null && s.last_pass_rate < (s.alert_pass_rate ?? 0)).length
  const avgTone = avgRate == null ? 'is-accent' : toneClass(avgRate, 80, 50)

  return (
    <>
      <header className="ao-hero ao-reveal">
        <div>
          <div className="ao-hero-eyebrow"><CalendarClock /> Recurring evals</div>
          <h1 className="ao-hero-title">Schedules</h1>
          <p className="ao-hero-sub">Run a saved scenario on a cadence; get alerted when the pass-rate slips below its threshold.</p>
        </div>
        <div className="ao-hero-actions">
          <Button size="sm" style={PRIMARY_FG} onClick={() => { setErr(null); setOpen(true) }} disabled={scenarios.length === 0}><Plus size={14} /> New schedule</Button>
        </div>
      </header>

      {err && <div className="ao-alert is-danger ao-reveal ao-reveal-1 mb-4"><AlertTriangle size={15} /> {err}</div>}
      {scenarios.length === 0 && <div className="ao-alert is-info ao-reveal ao-reveal-1 mb-4"><Activity size={15} /> Create a Scenario in the Library first — schedules run a saved scenario.</div>}

      <div className="ao-stat-row ao-stagger mb-6">
        <div className="ao-stat ao-stat--feature is-accent">
          <div className="ao-stat-label"><CalendarClock /> Schedules</div>
          <div className="ao-stat-value">{items.length}</div>
          <div className="ao-stat-meta">{activeN} active · {Math.max(0, items.length - activeN)} paused</div>
        </div>
        <div className={cn('ao-stat', avgTone)}>
          <div className="ao-stat-label"><Gauge /> Avg pass rate</div>
          <div className="ao-stat-value">{avgRate == null ? '—' : <>{avgRate}<span className="unit">%</span></>}</div>
          <div className="ao-stat-meta">{ratedItems.length} with a recent run</div>
        </div>
        <div className={cn('ao-stat', breaching > 0 ? 'is-bad' : 'is-good')}>
          <div className="ao-stat-label"><ShieldCheck /> Below threshold</div>
          <div className="ao-stat-value">{breaching}</div>
          <div className="ao-stat-meta">{breaching > 0 ? 'pass-rate slipping' : 'all holding'}</div>
        </div>
        <div className={cn('ao-stat', alerts.length > 0 ? 'is-warn' : 'is-good')}>
          <div className="ao-stat-label"><BellRing /> Recent alerts</div>
          <div className="ao-stat-value">{alerts.length}</div>
          <div className="ao-stat-meta">{alerts.length > 0 ? `last ${rel(alerts[0]?.created_at)}` : 'none fired'}</div>
        </div>
      </div>

      <section className="ao-panel ao-reveal ao-reveal-2 mb-6">
        <div className="ao-panel-head">
          <div>
            <div className="ao-panel-title"><CalendarClock /> Schedules</div>
            <div className="ao-panel-sub">Each runs its scenario on a fixed cadence and persists to Evals.</div>
          </div>
        </div>
        {items.length === 0
          ? (
            <div className="ao-panel-body">
              <div className="ao-empty">
                <div className="ao-empty-icon"><CalendarClock /></div>
                <div className="ao-empty-title">No schedules yet</div>
                <div className="ao-empty-text">Create a schedule to run a saved scenario on a cadence and watch its pass-rate over time.</div>
                {scenarios.length > 0 && (
                  <div className="ao-empty-actions">
                    <button className="ao-btn ao-btn--primary" onClick={() => { setErr(null); setOpen(true) }}><Plus size={14} /> New schedule</button>
                  </div>
                )}
              </div>
            </div>
          )
          : (
            <div className="ao-panel--flush" style={{ marginTop: 4 }}>
              <table className="ao-table">
                <thead>
                  <tr>
                    <th>Name</th><th>Scenario</th><th>Every</th><th>Last run</th><th>Pass rate</th><th>Next</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <span className="font-medium text-foreground">{s.name}</span>
                        {s.alert_pass_rate != null && <span className="ao-mono ml-2 text-[11px]">alert &lt;{s.alert_pass_rate}%</span>}
                      </td>
                      <td className="muted">{scenarioName(s.scenario_id)}</td>
                      <td className="num">{interval(s.interval_minutes)}</td>
                      <td className="muted">{rel(s.last_run_at)}</td>
                      <td className="num">{s.last_pass_rate == null ? <span className="muted">—</span> : <span className={cn('font-semibold', rateTone(s.last_pass_rate))}>{s.last_pass_rate}%</span>}</td>
                      <td className="muted">{s.enabled ? rel(s.next_run_at) : '—'}</td>
                      <td>{s.enabled ? <span className="ao-badge is-success ao-badge--dot is-pulse">active</span> : <span className="ao-badge is-neutral ao-badge--dot">paused</span>}</td>
                      <td>
                        <div className="flex justify-end gap-1">
                          {s.last_eval_run_id && <button title="Open last run" onClick={() => navigate(`/evals/${s.last_eval_run_id}`)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><CalendarClock size={15} /></button>}
                          <button title="Run now" onClick={() => runNow(s)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><Play size={15} /></button>
                          <button title={s.enabled ? 'Pause' : 'Resume'} onClick={() => toggle(s)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">{s.enabled ? <Pause size={15} /> : <Play size={15} />}</button>
                          <button title="Delete" onClick={() => del(s)} className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      <section className="ao-reveal ao-reveal-3">
        <div className="ao-section-label flex items-center gap-2"><AlertTriangle size={14} className="text-warning" /> Recent alerts</div>
        {alerts.length === 0
          ? (
            <div className="ao-empty">
              <div className="ao-empty-icon"><ShieldCheck /></div>
              <div className="ao-empty-title">No alerts</div>
              <div className="ao-empty-text">Pass-rates are holding above their thresholds.</div>
            </div>
          )
          : (
            <div className="flex flex-col gap-2">
              {alerts.map((a) => (
                <div key={a.id} className="ao-alert is-warning flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5 text-sm"><AlertTriangle size={15} className="shrink-0 text-warning" /><span className="text-foreground">{a.message}</span></div>
                  <div className="flex shrink-0 items-center gap-3 text-xs">
                    <span className="ao-mono">{rel(a.created_at)}</span>
                    {a.eval_run_id && <button onClick={() => navigate(`/evals/${a.eval_run_id}`)} className="font-medium text-primary hover:underline">view run</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
      </section>

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
            <Button style={PRIMARY_FG} onClick={create} disabled={!form.name.trim() || !form.scenario_id}>Create schedule</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
