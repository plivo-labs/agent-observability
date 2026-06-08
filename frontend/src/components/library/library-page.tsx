/* library-page.tsx — the Library: reusable Personas, Rubrics, and Scenarios,
 * persisted via /api/library/*. Truman-style management surface. */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { AlertTriangle, Bot, FileCode, Library as LibraryIcon, ListChecks, Lock, Pencil, Phone, Play, Plus, Trash2, UsersRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'

const PERSONA_TYPES = ['baseline', 'edge_case', 'workflow', 'knowledge', 'red_team'] as const
const AVATARS = ['#6366f1', '#0ea5e9', '#e11d48', '#f59e0b', '#8b5cf6', '#14b8a6', '#16a34a', '#3b82f6']
const initials = (n: string) => n.split(' ').map((w) => w[0]).slice(0, 2).join('')

interface Persona { id: string; name: string; type: string; goal: string; opener: string; voice: string; avatar: string; builtin: boolean; source: string }
interface Criterion { name: string; question: string; weight?: number }
interface Rubric { id: string; name: string; criteria: Criterion[]; pass_threshold: number; builtin: boolean }
interface Scenario { id: string; name: string; yaml: string; created_at: string }
interface Agent { id: string; name: string; phone_number: string; description: string; system_prompt: string; builtin: boolean; created_at: string }

async function api<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...opts })
  if (!res.ok) { let m = `Request failed (${res.status})`; try { m = (await res.json())?.error?.message ?? m } catch { /* ignore */ } throw new Error(m) }
  return res.json()
}

// The shadcn Button's custom size token (text-xs-500 / text-s-500) collides with
// text-primary-foreground in tailwind-merge, which drops the white text colour
// on the dark primary surface. Force it back with an inline style (always wins).
const PRIMARY_FG = { color: 'hsl(var(--primary-foreground))' } as const

/* ── shared presentational bits ─────────────────────────────────────────── */
function ErrorAlert({ message }: { message: string }) {
  return <div className="ao-alert is-danger mb-4"><AlertTriangle /> {message}</div>
}

function CardGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="ao-panel"><div className="ao-panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="ao-skeleton ao-skeleton--circle" />
            <div className="ao-skeleton ao-skeleton--title" style={{ flex: 1 }} />
          </div>
          <div className="ao-skeleton ao-skeleton--line" />
          <div className="ao-skeleton ao-skeleton--line" style={{ width: '70%' }} />
        </div></div>
      ))}
    </div>
  )
}

/* ============================ Personas ============================ */
const emptyPersona = { name: '', type: 'red_team', goal: '', opener: '', voice: 'cartesia/sonic', avatar: AVATARS[0] }

function PersonasTab() {
  const [items, setItems] = useState<Persona[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Persona | null>(null)
  const [form, setForm] = useState(emptyPersona)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = () => api<{ objects: Persona[] }>('/api/library/personas').then((d) => setItems(d.objects)).catch((e) => setErr(e.message)).finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  const openNew = () => { setEditing(null); setForm(emptyPersona); setErr(null); setOpen(true) }
  const openEdit = (p: Persona) => { setEditing(p); setForm({ name: p.name, type: p.type, goal: p.goal, opener: p.opener, voice: p.voice, avatar: p.avatar }); setErr(null); setOpen(true) }
  const save = async () => {
    setBusy(true); setErr(null)
    try {
      if (editing) await api(`/api/library/personas/${editing.id}`, { method: 'PATCH', body: JSON.stringify(form) })
      else await api('/api/library/personas', { method: 'POST', body: JSON.stringify(form) })
      setOpen(false); await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const del = async (p: Persona) => { if (!confirm(`Delete persona "${p.name}"?`)) return; await api(`/api/library/personas/${p.id}`, { method: 'DELETE' }).then(load).catch((e) => setErr(e.message)) }

  const customCount = items.filter((p) => !p.builtin).length

  return (
    <div>
      <div className="ao-toolbar mb-4">
        <p className="text-sm text-muted-foreground">Synthetic callers Simulate and Live drive against your agent — built-ins are locked, your own are editable.</p>
        <span className="ao-toolbar-spacer" />
        <span className="ao-mono">{items.length} total · {customCount} custom</span>
        <Button size="sm" onClick={openNew} style={PRIMARY_FG}><Plus size={14} /> New persona</Button>
      </div>
      {err && <ErrorAlert message={err} />}
      {loading ? <CardGridSkeleton /> : items.length === 0 ? (
        <div className="ao-empty">
          <div className="ao-empty-icon"><UsersRound /></div>
          <div className="ao-empty-title">No personas yet</div>
          <div className="ao-empty-text">Define a synthetic caller to drive against your agent in Simulate and Live.</div>
          <div className="ao-empty-actions"><button className="ao-btn ao-btn--primary" onClick={openNew}><Plus size={15} /> New persona</button></div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 ao-stagger">
          {items.map((p) => (
            <div key={p.id} className="ao-panel flex flex-col">
              <div className="ao-panel-body flex flex-col gap-3" style={{ padding: 16 }}>
                <div className="flex items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg text-xs font-semibold text-white shadow-sm" style={{ background: p.avatar }}>{initials(p.name)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-foreground">{p.name}</div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <span className="ao-badge is-neutral">{p.type.replace('_', ' ')}</span>
                      {p.source === 'generated' && <span className="ao-badge is-accent">AI</span>}
                    </div>
                  </div>
                  {p.builtin
                    ? <Lock size={14} className="text-muted-foreground" />
                    : <div className="flex gap-1">
                        <button onClick={() => openEdit(p)} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><Pencil size={14} /></button>
                        <button onClick={() => del(p)} className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 size={14} /></button>
                      </div>}
                </div>
                {p.goal && <div className="text-xs leading-relaxed text-muted-foreground">{p.goal}</div>}
                {p.opener && <div className="rounded-md bg-muted/50 px-2.5 py-1.5 text-[11px] italic text-muted-foreground">“{p.opener}”</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? 'Edit persona' : 'New persona'}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="ao-field"><label className="ao-label">Name <span className="req">*</span></label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Refund Demander" /></div>
            <div className="ao-field-row">
              <div className="ao-field"><label className="ao-label">Type</label>
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{PERSONA_TYPES.map((t) => <SelectItem key={t} value={t}>{t.replace('_', ' ')}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="ao-field"><label className="ao-label">Voice</label><Input value={form.voice} onChange={(e) => setForm({ ...form, voice: e.target.value })} /></div>
            </div>
            <div className="ao-field"><label className="ao-label">Goal</label><textarea value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} rows={2} className="ao-textarea" placeholder="What this caller tries to do" /></div>
            <div className="ao-field"><label className="ao-label">Opener</label><Input value={form.opener} onChange={(e) => setForm({ ...form, opener: e.target.value })} placeholder="Their first line" /></div>
            <div className="ao-field"><label className="ao-label">Colour</label>
              <div className="mt-1 flex gap-2">{AVATARS.map((a) => <button key={a} onClick={() => setForm({ ...form, avatar: a })} className={cn('size-7 rounded-md transition', form.avatar === a ? 'ring-2 ring-ring ring-offset-2 ring-offset-background' : 'hover:scale-110')} style={{ background: a }} />)}</div>
            </div>
            {err && <div className="ao-error">{err}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={busy || !form.name.trim()} style={PRIMARY_FG}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create persona'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ============================ Rubrics ============================ */
const emptyCriterion = (): Criterion => ({ name: '', question: '', weight: 1 })

function RubricsTab() {
  const [items, setItems] = useState<Rubric[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Rubric | null>(null)
  const [name, setName] = useState('')
  const [threshold, setThreshold] = useState(70)
  const [criteria, setCriteria] = useState<Criterion[]>([emptyCriterion()])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const load = () => api<{ objects: Rubric[] }>('/api/library/rubrics').then((d) => setItems(d.objects)).catch((e) => setErr(e.message)).finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  const openNew = () => { setEditing(null); setName(''); setThreshold(70); setCriteria([emptyCriterion()]); setErr(null); setOpen(true) }
  const openEdit = (r: Rubric) => { setEditing(r); setName(r.name); setThreshold(r.pass_threshold); setCriteria(r.criteria.length ? r.criteria.map((c) => ({ ...c, weight: c.weight ?? 1 })) : [emptyCriterion()]); setErr(null); setOpen(true) }
  const save = async () => {
    setBusy(true); setErr(null)
    const payload = { name, pass_threshold: threshold, criteria: criteria.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), question: c.question.trim(), weight: c.weight ?? 1 })) }
    try {
      if (editing) await api(`/api/library/rubrics/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      else await api('/api/library/rubrics', { method: 'POST', body: JSON.stringify(payload) })
      setOpen(false); await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const del = async (r: Rubric) => { if (!confirm(`Delete rubric "${r.name}"?`)) return; await api(`/api/library/rubrics/${r.id}`, { method: 'DELETE' }).then(load).catch((e) => setErr(e.message)) }

  return (
    <div>
      <div className="ao-toolbar mb-4">
        <p className="text-sm text-muted-foreground">Yes/no criteria the judge evaluates each run against — overall passes only when every criterion does.</p>
        <span className="ao-toolbar-spacer" />
        <span className="ao-mono">{items.length} rubrics</span>
        <Button size="sm" onClick={openNew} style={PRIMARY_FG}><Plus size={14} /> New rubric</Button>
      </div>
      {err && <ErrorAlert message={err} />}
      {loading ? (
        <div className="ao-panel"><div className="ao-panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="ao-skeleton ao-skeleton--line" />
          <div className="ao-skeleton ao-skeleton--line" style={{ width: '85%' }} />
          <div className="ao-skeleton ao-skeleton--line" style={{ width: '70%' }} />
        </div></div>
      ) : items.length === 0 ? (
        <div className="ao-empty">
          <div className="ao-empty-icon"><ListChecks /></div>
          <div className="ao-empty-title">No rubrics yet</div>
          <div className="ao-empty-text">Author a set of yes/no criteria the judge uses to score every simulation and call.</div>
          <div className="ao-empty-actions"><button className="ao-btn ao-btn--primary" onClick={openNew}><Plus size={15} /> New rubric</button></div>
        </div>
      ) : (
        <div className="ao-panel ao-panel--flush">
          <table className="ao-table">
            <thead><tr><th>Name</th><th>Criteria</th><th>Pass threshold</th><th /></tr></thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} style={{ cursor: 'default' }}>
                  <td className="align-top font-medium text-foreground">{r.name} {r.builtin && <Badge variant="outline" className="ml-1">builtin</Badge>}</td>
                  <td className="align-top"><div className="flex flex-wrap gap-1">{r.criteria.map((c) => <span key={c.name} className="ao-badge is-neutral" title={c.question}>{c.name}{c.weight != null && c.weight !== 1 ? ` ·${c.weight}` : ''}</span>)}{r.criteria.length === 0 && <span className="text-[11px] italic text-muted-foreground">no criteria</span>}</div></td>
                  <td className="num align-top">{r.pass_threshold}</td>
                  <td className="align-top text-right">
                    {r.builtin
                      ? <Lock size={14} className="ml-auto text-muted-foreground" />
                      : <div className="flex justify-end gap-1">
                          <button onClick={() => openEdit(r)} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><Pencil size={14} /></button>
                          <button onClick={() => del(r)} className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 size={14} /></button>
                        </div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? 'Edit rubric' : 'New rubric'}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="ao-field-row">
              <div className="ao-field"><label className="ao-label">Name <span className="req">*</span></label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Support QA rubric" /></div>
              <div className="ao-field"><label className="ao-label">Pass threshold</label><Input type="number" value={threshold} onChange={(e) => setThreshold(+e.target.value)} /></div>
            </div>
            <div>
              <div className="ao-section-label">Criteria</div>
              <p className="mb-2 text-xs text-muted-foreground">Each criterion is a yes/no check. The question is the prompt the judge answers; weight feeds Simulate score synthesis.</p>
              <div className="flex max-h-[42vh] flex-col gap-2 overflow-y-auto pr-1">
                {criteria.map((c, i) => (
                  <div key={i} className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 p-2.5">
                    <div className="flex gap-2">
                      <Input value={c.name} onChange={(e) => setCriteria(criteria.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="Criterion name" />
                      <Input type="number" step="0.5" value={c.weight ?? 1} onChange={(e) => setCriteria(criteria.map((x, j) => j === i ? { ...x, weight: +e.target.value } : x))} className="w-20" title="weight" />
                      <button onClick={() => setCriteria(criteria.filter((_, j) => j !== i))} className="rounded p-2 text-muted-foreground hover:text-destructive"><Trash2 size={14} /></button>
                    </div>
                    <Input value={c.question} onChange={(e) => setCriteria(criteria.map((x, j) => j === i ? { ...x, question: e.target.value } : x))} placeholder="Judge question — e.g. Did the agent confirm the order total?" />
                  </div>
                ))}
                <button className="ao-btn ao-btn--outline ao-btn--sm" onClick={() => setCriteria([...criteria, emptyCriterion()])}><Plus size={13} /> Add criterion</button>
              </div>
            </div>
            {err && <div className="ao-error">{err}</div>}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save} disabled={busy || !name.trim()} style={PRIMARY_FG}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create rubric'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ============================ Agents ============================ */
const emptyAgent = { name: '', phone_number: '', description: '', system_prompt: '' }

function AgentsTab() {
  const [items, setItems] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Agent | null>(null)
  const [form, setForm] = useState(emptyAgent)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = () => api<{ objects: Agent[] }>('/api/library/agents').then((d) => setItems(d.objects)).catch((e) => setErr(e.message)).finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  const openNew = () => { setEditing(null); setForm(emptyAgent); setErr(null); setOpen(true) }
  const openEdit = (a: Agent) => { setEditing(a); setForm({ name: a.name, phone_number: a.phone_number ?? '', description: a.description ?? '', system_prompt: a.system_prompt }); setErr(null); setOpen(true) }
  const save = async () => {
    setBusy(true); setErr(null)
    try {
      if (editing) await api(`/api/library/agents/${editing.id}`, { method: 'PATCH', body: JSON.stringify(form) })
      else await api('/api/library/agents', { method: 'POST', body: JSON.stringify(form) })
      setOpen(false); await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const del = async (a: Agent) => { if (!confirm(`Delete agent "${a.name}"?`)) return; await api(`/api/library/agents/${a.id}`, { method: 'DELETE' }).then(load).catch((e) => setErr(e.message)) }

  return (
    <div>
      <div className="ao-toolbar mb-4">
        <p className="text-sm text-muted-foreground">The agent-under-test prompts used by Simulate and Live.</p>
        <span className="ao-toolbar-spacer" />
        <span className="ao-mono">{items.length} agents</span>
        <Button size="sm" onClick={openNew} style={PRIMARY_FG}><Plus size={14} /> New agent</Button>
      </div>
      {err && <ErrorAlert message={err} />}
      {loading ? <CardGridSkeleton /> : items.length === 0 ? (
        <div className="ao-empty">
          <div className="ao-empty-icon"><Bot /></div>
          <div className="ao-empty-title">No agents yet</div>
          <div className="ao-empty-text">Register an agent-under-test — its system prompt drives Simulate sims and Live calls.</div>
          <div className="ao-empty-actions"><button className="ao-btn ao-btn--primary" onClick={openNew}><Plus size={15} /> New agent</button></div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 ao-stagger">
          {items.map((a) => (
            <div key={a.id} className="ao-panel flex flex-col">
              <div className="ao-panel-body flex flex-col gap-3" style={{ padding: 16 }}>
                <div className="flex items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary"><Bot size={19} /></div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-foreground">{a.name}</div>
                    {a.phone_number && <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"><Phone size={11} /> <span className="ao-mono">{a.phone_number}</span></div>}
                  </div>
                  {a.builtin
                    ? <Lock size={14} className="text-muted-foreground" />
                    : <div className="flex gap-1">
                        <button onClick={() => openEdit(a)} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><Pencil size={14} /></button>
                        <button onClick={() => del(a)} className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 size={14} /></button>
                      </div>}
                </div>
                {a.description && <div className="text-xs leading-relaxed text-muted-foreground">{a.description}</div>}
                <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground" style={{ fontFamily: 'var(--mono)' }}>{a.system_prompt}</pre>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? 'Edit agent' : 'New agent'}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="ao-field-row">
              <div className="ao-field"><label className="ao-label">Name <span className="req">*</span></label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Pluto Pizza" /></div>
              <div className="ao-field"><label className="ao-label">Phone number</label><Input value={form.phone_number} onChange={(e) => setForm({ ...form, phone_number: e.target.value })} placeholder="+1 415 555 0142" /></div>
            </div>
            <div className="ao-field"><label className="ao-label">Description</label><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What this agent does" /></div>
            <div className="ao-field"><label className="ao-label">System prompt <span className="req">*</span></label><textarea value={form.system_prompt} onChange={(e) => setForm({ ...form, system_prompt: e.target.value })} rows={7} className="ao-textarea mono" placeholder="You are the … agent. Greet callers warmly, …" /></div>
            {err && <div className="ao-error">{err}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={busy || !form.name.trim() || !form.system_prompt.trim()} style={PRIMARY_FG}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create agent'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ============================ Scenarios ============================ */
const SAMPLE_YAML = `version: v0
name: "New scenario"
target:
  mode: text
  prompt: "You are a helpful agent."
personas:
  - use: builtin
    id: happy-path
rubric: { use: builtin, pass_threshold: 70 }
judge: { levels: [flow, agent, task, node], model: gpt-4o }`

function ScenariosTab() {
  const navigate = useNavigate()
  const [items, setItems] = useState<Scenario[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [yaml, setYaml] = useState(SAMPLE_YAML)
  const [err, setErr] = useState<string | null>(null)
  const load = () => api<{ objects: Scenario[] }>('/api/library/scenarios').then((d) => setItems(d.objects)).catch((e) => setErr(e.message)).finally(() => setLoading(false))
  useEffect(() => { load() }, [])
  const save = async () => { try { await api('/api/library/scenarios', { method: 'POST', body: JSON.stringify({ name, yaml }) }); setOpen(false); setName(''); setYaml(SAMPLE_YAML); await load() } catch (e) { setErr((e as Error).message) } }
  const del = async (s: Scenario) => { if (!confirm(`Delete scenario "${s.name}"?`)) return; await api(`/api/library/scenarios/${s.id}`, { method: 'DELETE' }).then(load).catch((e) => setErr(e.message)) }

  return (
    <div>
      <div className="ao-toolbar mb-4">
        <p className="text-sm text-muted-foreground">A YAML sim definition, saved and re-runnable — each maps 1:1 onto a simulation.</p>
        <span className="ao-toolbar-spacer" />
        <span className="ao-mono">{items.length} scenarios</span>
        <Button size="sm" onClick={() => { setErr(null); setOpen(true) }} style={PRIMARY_FG}><Plus size={14} /> New scenario</Button>
      </div>
      {err && <ErrorAlert message={err} />}
      {loading ? (
        <div className="ao-panel"><div className="ao-panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="ao-skeleton ao-skeleton--title" />
          <div className="ao-skeleton ao-skeleton--line" />
          <div className="ao-skeleton ao-skeleton--line" style={{ width: '80%' }} />
        </div></div>
      ) : items.length === 0 ? (
        <div className="ao-empty">
          <div className="ao-empty-icon"><FileCode /></div>
          <div className="ao-empty-title">No scenarios yet</div>
          <div className="ao-empty-text">Create one — it maps 1:1 onto a runnable simulation you can replay any time.</div>
          <div className="ao-empty-actions"><button className="ao-btn ao-btn--primary" onClick={() => { setErr(null); setOpen(true) }}><Plus size={15} /> New scenario</button></div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 ao-stagger">
          {items.map((s) => (
            <section key={s.id} className="ao-panel">
              <div className="ao-panel-head">
                <div className="ao-panel-title"><FileCode /> {s.name}</div>
                <div className="ao-hero-actions">
                  <button className="ao-btn ao-btn--primary ao-btn--sm" onClick={() => navigate('/simulate', { state: { scenario: { name: s.name, yaml: s.yaml } } })}><Play size={13} /> Run</button>
                  <button onClick={() => del(s)} className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 size={14} /></button>
                </div>
              </div>
              <div className="ao-panel-body">
                <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-2.5 text-[11px] leading-relaxed text-muted-foreground" style={{ fontFamily: 'var(--mono)' }}>{s.yaml}</pre>
              </div>
            </section>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New scenario</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="ao-field"><label className="ao-label">Name <span className="req">*</span></label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pluto Pizza pre-launch sweep" /></div>
            <div className="ao-field"><label className="ao-label">YAML <span className="req">*</span></label><textarea value={yaml} onChange={(e) => setYaml(e.target.value)} rows={12} className="ao-textarea mono" /></div>
            {err && <div className="ao-error">{err}</div>}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save} disabled={!name.trim() || !yaml.trim()} style={PRIMARY_FG}>Create scenario</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ============================ page ============================ */
export function LibraryPage() {
  return (
    <div>
      <header className="ao-hero ao-reveal">
        <div>
          <div className="ao-hero-eyebrow"><LibraryIcon /> Catalog</div>
          <h1 className="ao-hero-title">Library</h1>
          <p className="ao-hero-sub">Reusable agents, personas, rubrics, and scenarios — shared across Simulate, Live, Evals, and Monitor.</p>
        </div>
      </header>
      <Tabs defaultValue="agents" className="ao-reveal ao-reveal-2">
        <TabsList className="ao-subtabs">
          <TabsTrigger value="agents"><Bot size={14} /> Agents</TabsTrigger>
          <TabsTrigger value="personas"><UsersRound size={14} /> Personas</TabsTrigger>
          <TabsTrigger value="rubrics"><ListChecks size={14} /> Rubrics</TabsTrigger>
          <TabsTrigger value="scenarios"><FileCode size={14} /> Scenarios</TabsTrigger>
        </TabsList>
        <TabsContent value="agents" className="mt-1"><AgentsTab /></TabsContent>
        <TabsContent value="personas" className="mt-1"><PersonasTab /></TabsContent>
        <TabsContent value="rubrics" className="mt-1"><RubricsTab /></TabsContent>
        <TabsContent value="scenarios" className="mt-1"><ScenariosTab /></TabsContent>
      </Tabs>
    </div>
  )
}
