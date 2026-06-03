/* simulate-page.tsx — the Simulate module: Define → Run → Report.
 * Results come from POST /api/simulations, so they reflect the pasted prompt.
 * The leveled judge (flow → agent → task → node) is the centerpiece. */
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import {
  AlertOctagon, AlertTriangle, Check, CheckCircle2, ChevronRight, CopyIcon,
  CornerDownRight, Download, FileCode, GitPullRequest, Loader, Phone,
  Play, Plus, RotateCw, Scale, Sparkles, TextCursorInput,
  Timer, TriangleAlert, UploadCloud, Wrench, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DEFAULT_PROMPT, PERSONA_TYPES, PERSONAS, SIM_YAML, generatePersonas, listLibraryPersonas,
  listRubrics, runSimulation, savePersonaToLibrary,
  type CaseStatus, type JudgeTreeT, type Persona, type Rubric, type Severity, type SimResult, type Turn,
} from './sim-data'
import { readSimRun, writeSimRun, clearSimRun } from './run-persistence'

/* ---------- helpers ---------- */
const scoreText = (s: number) => (s >= 80 ? 'text-success' : s >= 65 ? 'text-warning' : 'text-destructive')
const scoreStroke = (s: number) => (s >= 80 ? 'hsl(var(--success))' : s >= 65 ? 'hsl(var(--warning))' : 'hsl(var(--destructive))')
const scoreBar = (s: number) => (s >= 80 ? 'bg-success' : s >= 65 ? 'bg-warning' : 'bg-destructive')
const initials = (name: string) => name.split(' ').map((w) => w[0]).slice(0, 2).join('')

/* ---------- primitives ---------- */
function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('rounded-lg border border-border bg-card', className)}>{children}</div>
}
function CardHead({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex items-center gap-2 border-b border-border px-4 py-3', className)}>{children}</div>
}
function CardTitle({ children }: { children: React.ReactNode }) {
  return <span className="text-sm font-semibold text-foreground">{children}</span>
}
function CardSub({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>
}

function ScoreRing({ score, max = 100, size = 64, stroke = 6, showMax }: { score: number; max?: number; size?: number; stroke?: number; showMax?: boolean }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(1, score / max))
  const fs = size >= 88 ? 26 : size >= 64 ? 19 : 15
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={scoreStroke(score)} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)}
          style={{ transition: 'stroke-dashoffset .6s ease-out' }} />
      </svg>
      <div className={cn('absolute inset-0 flex items-center justify-center font-semibold tabular-nums', scoreText(score))} style={{ fontSize: fs }}>
        {score}{showMax && <span className="text-muted-foreground" style={{ fontSize: fs * 0.55 }}>/{max}</span>}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string; dot?: boolean }> = {
    pass: { cls: 'bg-success/15 text-success', label: 'Pass' },
    fail: { cls: 'bg-destructive/15 text-destructive', label: 'Fail' },
    warn: { cls: 'bg-warning/15 text-warning', label: 'At risk' },
    live: { cls: 'bg-primary/15 text-primary', label: 'Live', dot: true },
    info: { cls: 'bg-primary/10 text-primary', label: 'info' },
    neutral: { cls: 'bg-muted text-muted-foreground', label: status },
  }
  const m = map[status] ?? map.neutral
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', m.cls)}>
      {m.dot && <span className="size-1.5 rounded-full bg-current animate-pulse" />}
      {m.label}
    </span>
  )
}

function ScopeTag({ scope }: { scope: string }) {
  const level = scope.split(':')[0]
  const colors: Record<string, string> = {
    flow: 'bg-chart-2/12 text-[hsl(270_82%_51%)]',
    agent: 'bg-chart-1/12 text-[hsl(225_100%_45%)]',
    task: 'bg-chart-4/12 text-[hsl(38_96%_40%)]',
    node: 'bg-chart-3/12 text-[hsl(149_89%_32%)]',
  }
  return <span className={cn('rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium', colors[level] ?? 'bg-muted text-muted-foreground')}>{scope}</span>
}

function Seg({ options, value, onChange }: { options: { id: string; label: React.ReactNode }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5">
      {options.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)}
          className={cn('flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
            value === o.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Stepper({ phase }: { phase: 'setup' | 'running' | 'report' }) {
  const steps = [{ id: 'setup', label: 'Define' }, { id: 'running', label: 'Run' }, { id: 'report', label: 'Report' }]
  const idx = steps.findIndex((s) => s.id === phase)
  return (
    <div className="mb-6 flex items-center gap-2">
      {steps.map((s, i) => (
        <div key={s.id} className="flex items-center gap-2">
          <div className={cn('flex items-center gap-2 text-sm', i === idx ? 'font-semibold text-foreground' : i < idx ? 'text-foreground' : 'text-muted-foreground')}>
            <span className={cn('flex size-6 items-center justify-center rounded-full text-xs font-semibold',
              i < idx ? 'bg-primary text-primary-foreground' : i === idx ? 'border-2 border-primary text-primary' : 'border border-border')}>
              {i < idx ? <Check size={13} /> : i + 1}
            </span>
            {s.label}
          </div>
          {i < steps.length - 1 && <div className={cn('h-px w-10', i < idx ? 'bg-primary' : 'bg-border')} />}
        </div>
      ))}
    </div>
  )
}

function Transcript({ turns, highlight, refMap }: { turns: Turn[]; highlight?: number | null; refMap?: React.MutableRefObject<Record<number, HTMLDivElement | null>> }) {
  return (
    <div className="flex flex-col gap-3">
      {turns.map((t, i) => {
        const isUser = t.role === 'user'
        return (
          <div key={i} ref={(el) => { if (refMap) refMap.current[i] = el }}
            className={cn('flex gap-2.5', isUser ? 'flex-row-reverse' : '')}
            style={highlight === i ? { outline: '2px solid hsl(var(--ring))', outlineOffset: 4, borderRadius: 12 } : undefined}>
            <div className={cn('flex size-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold',
              isUser ? 'bg-muted text-muted-foreground' : 'bg-primary/12 text-primary')}>{isUser ? 'U' : 'AI'}</div>
            <div className={cn('min-w-0 flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
              <div className={cn('max-w-[42ch] rounded-xl px-3 py-2 text-sm', isUser ? 'bg-muted' : 'bg-primary/8', t.flag ? 'ring-1 ring-destructive/40' : '')}>{t.t}</div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                {!isUser && t.ms != null && <span className={cn('inline-flex items-center gap-1', t.ms > 800 ? 'text-destructive' : '')}><Timer size={11} />{t.ms}ms</span>}
                {t.flag && <span className="inline-flex items-center gap-1 text-destructive"><AlertTriangle size={11} /> {t.flag}</span>}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function JudgeRow({ children, indent = 0, onClick }: { children: React.ReactNode; indent?: number; onClick?: () => void }) {
  return (
    <div onClick={onClick} className={cn('flex items-center gap-2.5 border-b border-border/60 px-4 py-2.5 text-sm', onClick ? 'cursor-pointer hover:bg-muted/40' : '')} style={{ paddingLeft: 16 + indent }}>
      {children}
    </div>
  )
}

function JudgeTree({ tree, onJump }: { tree: JudgeTreeT; onJump: (turn: number) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const o: Record<string, boolean> = {}
    tree.agents.forEach((a) => { if (a.status === 'fail') { o[a.id] = true; a.tasks.forEach((t) => { if (t.status === 'fail') o[t.id] = true }) } })
    return o
  })
  const tog = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }))
  return (
    <div>
      <JudgeRow>
        <ScopeTag scope="flow" />
        <span className="min-w-0 flex-1 font-medium text-foreground">{tree.flow.verdict}</span>
        <span className={cn('font-semibold tabular-nums', scoreText(tree.flow.score))}>{tree.flow.score}/{tree.flow.max}</span>
      </JudgeRow>
      {tree.agents.map((ag) => (
        <div key={ag.id}>
          <JudgeRow indent={12} onClick={() => tog(ag.id)}>
            <ChevronRight size={15} className={cn('shrink-0 text-muted-foreground transition-transform', open[ag.id] ? 'rotate-90' : '')} />
            <ScopeTag scope={`agent:${ag.id.replace('-agent', '')}`} />
            <span className="min-w-0 flex-1 truncate"><b className="text-foreground">{ag.name}</b> <span className="text-muted-foreground">— {ag.verdict}</span></span>
            <StatusBadge status={ag.status} />
            <span className={cn('font-semibold tabular-nums', scoreText(ag.score))}>{ag.score}</span>
          </JudgeRow>
          {open[ag.id] && ag.tasks.map((tk) => (
            <div key={tk.id}>
              <JudgeRow indent={36} onClick={tk.nodes ? () => tog(tk.id) : undefined}>
                {tk.nodes ? <ChevronRight size={14} className={cn('shrink-0 text-muted-foreground transition-transform', open[tk.id] ? 'rotate-90' : '')} /> : <span className="w-3.5 shrink-0" />}
                <ScopeTag scope={`task:${tk.id}`} />
                <span className="min-w-0 flex-1 text-muted-foreground">{tk.verdict}</span>
                <StatusBadge status={tk.status} />
                <span className={cn('font-semibold tabular-nums', scoreText(tk.score))}>{tk.score}</span>
              </JudgeRow>
              {tk.nodes && open[tk.id] && tk.nodes.map((nd, i) => (
                <div key={i} className="flex items-start gap-2.5 border-b border-border/60 bg-muted/30 px-4 py-2.5 text-sm" style={{ paddingLeft: 64 }}>
                  <ScopeTag scope={nd.scope} />
                  <div className="min-w-0 flex-1">
                    <div className="text-muted-foreground">{nd.verdict}</div>
                    {nd.turn != null && (
                      <button onClick={() => onJump(nd.turn!)} className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                        <CornerDownRight size={12} /> Jump to turn {nd.turn + 1}
                      </button>
                    )}
                  </div>
                  <StatusBadge status={nd.status} />
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function JudgeCard({ tree, onJump }: { tree: JudgeTreeT; onJump: (turn: number) => void }) {
  const counts = { flow: 1, agent: tree.agents.length, task: tree.agents.reduce((a, g) => a + g.tasks.length, 0), node: tree.nodes.length }
  const [level, setLevel] = useState('all')
  return (
    <Card>
      <CardHead>
        <Scale size={18} className="text-primary" />
        <div className="flex flex-col"><CardTitle>Leveled judge · {tree.caseLabel}</CardTitle><CardSub>Worst case · one verdict per node · task · agent · flow</CardSub></div>
        <div className="flex-1" />
        <StatusBadge status="info" /><span className="-ml-1 text-xs text-primary">LiveKit-native</span>
      </CardHead>
      <div className="border-b border-border px-4 py-3">
        <Seg value={level} onChange={setLevel} options={['all', 'flow', 'agent', 'task', 'node'].map((l) => ({
          id: l, label: <>{l === 'all' ? 'All levels' : l[0].toUpperCase() + l.slice(1)}{l !== 'all' && <span className="ml-1 rounded bg-muted px-1 text-[10px]">{counts[l as keyof typeof counts]}</span>}</>,
        }))} />
      </div>
      <JudgeTree tree={tree} onJump={onJump} />
      <div className="border-t border-border bg-muted/30 px-4 py-3.5">
        <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Pipeline nodes</div>
        <div className="flex flex-wrap gap-2.5">
          {tree.nodes.map((n, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
              <ScopeTag scope={n.scope} /><StatusBadge status={n.status} /><span className="max-w-[220px] text-[11px] text-muted-foreground">{n.verdict}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}

function PersonaCard({ p, selected, onClick, state }: {
  p: Persona; selected?: boolean; onClick?: () => void
  state?: { status: 'running' | CaseStatus; score?: number; prog?: number; meta?: string }
}) {
  return (
    <div onClick={onClick}
      className={cn('flex flex-col gap-2.5 rounded-lg border bg-card p-3 transition-all',
        onClick ? 'cursor-pointer' : '', selected ? 'border-primary ring-1 ring-primary' : 'border-border', onClick && !selected ? 'opacity-70 hover:opacity-100' : '')}>
      <div className="flex items-center gap-2.5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold text-white" style={{ background: p.avatar }}>{initials(p.name)}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{p.name}</div>
          <div className="text-xs text-muted-foreground">{p.type.replace('_', ' ')}{p.generated ? ' · AI' : p.builtin ? ' · builtin' : ''}</div>
        </div>
        {state?.status === 'running' && <StatusBadge status="live" />}
        {(state?.status === 'pass' || state?.status === 'fail') && <ScoreRing score={state.score!} size={40} stroke={4} />}
        {!state && selected && <CheckCircle2 size={18} className="text-primary" />}
      </div>
      <div className="text-xs text-muted-foreground">{p.goal}</div>
      {state?.status === 'running' && (
        <>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${state.prog}%` }} /></div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Loader size={12} className="animate-spin" /> {state.meta}</div>
        </>
      )}
      {!state && <div className="flex items-center justify-between border-t border-border pt-2"><span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{p.voice}</span></div>}
    </div>
  )
}

function YamlBlock({ src }: { src: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 text-[12px] leading-relaxed">
      {src.split('\n').map((line, i) => {
        const c = line.indexOf('#')
        const code = c >= 0 ? line.slice(0, c) : line
        const cmt = c >= 0 ? line.slice(c) : ''
        return <div key={i} className="font-mono whitespace-pre"><span className="text-foreground">{code}</span>{cmt && <span className="text-muted-foreground/60">{cmt}</span>}</div>
      })}
    </pre>
  )
}

function PageHeader({ title, sub, actions }: { title: React.ReactNode; sub: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div><h1 className="text-[26px] font-semibold leading-8 text-foreground">{title}</h1><div className="mt-1 text-sm text-muted-foreground">{sub}</div></div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

const btn = 'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50'
const btnPrimary = cn(btn, 'bg-primary text-primary-foreground hover:bg-primary/90 px-3.5 py-2')
const btnOut = cn(btn, 'border border-border bg-card hover:bg-accent px-3 py-2')
const btnOutSm = cn(btn, 'border border-border bg-card hover:bg-accent px-2.5 py-1 text-xs')

export interface RunConfig { prompt?: string; yaml?: string; mode: string; personaIds: string[]; personas?: Persona[]; rubric?: { id?: string; name?: string; criteria?: { name: string; question: string; weight?: number }[]; pass_threshold?: number }; autoGen: boolean; threshold: number; phoneNumber?: string }

/* ---------- Define ---------- */
function SetupPhase({ onRun }: { onRun: (c: RunConfig) => void }) {
  const [tab, setTab] = useState('prompt')
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [mode, setMode] = useState('text')
  const [typeFilter, setTypeFilter] = useState('all')
  const [lib, setLib] = useState<Persona[]>(PERSONAS)
  const [selected, setSelected] = useState(PERSONAS.map((p) => p.id))
  const [genList, setGenList] = useState<Persona[]>([])
  const [selGen, setSelGen] = useState<string[]>([])
  const [savedGen, setSavedGen] = useState<string[]>([])
  const [genLoading, setGenLoading] = useState(false)
  const [genErr, setGenErr] = useState<string | null>(null)
  const [threshold, setThreshold] = useState(70)
  const [rubrics, setRubrics] = useState<Rubric[]>([])
  const [rubricId, setRubricId] = useState('')
  const [phoneNo, setPhoneNo] = useState('') // target # for voice modes (real calls)
  // Load personas + rubrics from the Library so saved/custom ones appear here.
  useEffect(() => {
    listLibraryPersonas().then((ps) => { if (ps.length) { setLib(ps); setSelected(ps.map((p) => p.id)) } }).catch(() => { /* keep built-in fallback */ })
    listRubrics().then((rs) => { if (rs.length) { setRubrics(rs); setRubricId(rs[0].id); setThreshold(rs[0].pass_threshold) } }).catch(() => {})
  }, [])
  const selectedRubric = rubrics.find((r) => r.id === rubricId)
  const onRubricChange = (id: string) => { setRubricId(id); const r = rubrics.find((x) => x.id === id); if (r) setThreshold(r.pass_threshold) }
  const rubricPayload = selectedRubric ? { id: selectedRubric.id, name: selectedRubric.name, criteria: selectedRubric.criteria, pass_threshold: threshold } : undefined
  const filtered = typeFilter === 'all' ? lib : lib.filter((p) => p.type === typeFilter)
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const toggleGen = (id: string) => setSelGen((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const chosenGen = genList.filter((p) => selGen.includes(p.id))
  const selectedLib = lib.filter((p) => selected.includes(p.id))
  const saveGen = (p: Persona) => {
    savePersonaToLibrary(p)
      .then(() => { setSavedGen((s) => [...s, p.id]); listLibraryPersonas().then(setLib).catch(() => {}) })
      .catch((e) => setGenErr(e.message))
  }
  const doGenerate = () => {
    setGenLoading(true); setGenErr(null)
    generatePersonas(tab === 'yaml' ? SIM_YAML : prompt, 3, ['red_team', 'edge_case'])
      .then((r) => { setGenList(r.personas); setSelGen(r.personas.map((p) => p.id)) })
      .catch((e) => setGenErr(e.message))
      .finally(() => setGenLoading(false))
  }
  const isVoice = mode === 'voice' || mode === 'text_then_voice'
  const needsPhone = isVoice && !phoneNo.trim()
  const run = () => onRun(tab === 'yaml'
    ? { yaml: SIM_YAML, mode, personaIds: [], personas: [...selectedLib, ...chosenGen], rubric: rubricPayload, autoGen: false, threshold, phoneNumber: phoneNo.trim() || undefined }
    : { prompt, mode, personaIds: [], personas: [...selectedLib, ...chosenGen], rubric: rubricPayload, autoGen: false, threshold, phoneNumber: phoneNo.trim() || undefined })

  return (
    <div className="animate-in fade-in duration-300">
      <PageHeader title="New simulation" sub="Paste a prompt or upload a YAML, pick personas, and run a persona-driven sweep." />
      <Stepper phase="setup" />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <div className="flex flex-col gap-5">
          <Card>
            <CardHead><CardTitle>Agent under test</CardTitle><div className="flex-1" />
              <Seg value={tab} onChange={setTab} options={[{ id: 'prompt', label: <><TextCursorInput size={14} /> Paste a prompt</> }, { id: 'yaml', label: <><FileCode size={14} /> Upload YAML</> }]} />
            </CardHead>
            <div className="p-4">
              {tab === 'prompt' ? (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">System prompt</label>
                  <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6}
                    className="w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-[13px] leading-relaxed outline-none focus:ring-2 focus:ring-ring" />
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Or reference a registered <span className="font-mono">agent_id</span> / phone number.</span>
                    <Seg value={mode} onChange={setMode} options={['text', 'voice', 'text_then_voice'].map((m) => ({ id: m, label: <span className="font-mono text-[11px]">{m}</span> }))} />
                  </div>
                </div>
              ) : (
                <div>
                  <div className="mb-3.5 flex flex-col items-center gap-1 rounded-lg border border-dashed border-border bg-muted/30 py-7 text-center">
                    <UploadCloud size={30} className="text-muted-foreground" />
                    <div className="text-sm font-semibold text-foreground">Drop <span className="font-mono">sim.yaml</span> here</div>
                    <div className="text-xs text-muted-foreground">Validated with Zod · friendly per-field errors · maps 1:1 onto a reusable scenario</div>
                  </div>
                  <YamlBlock src={SIM_YAML} />
                </div>
              )}
            </div>
          </Card>
          <Card>
            <CardHead><CardTitle>Personas</CardTitle><CardSub>{selected.length + chosenGen.length} selected</CardSub><div className="flex-1" /><button className={btnOutSm}><Plus size={13} /> New persona</button></CardHead>
            <div className="p-4">
              <div className="mb-3.5 flex flex-wrap gap-1.5">
                {['all', ...PERSONA_TYPES].map((t) => (
                  <span key={t} onClick={() => setTypeFilter(t)} className={cn('cursor-pointer rounded-full px-2.5 py-1 text-xs font-medium', typeFilter === t ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground')}>{t === 'all' ? 'All' : t.replace('_', ' ')}</span>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {filtered.map((p) => <PersonaCard key={p.id} p={p} selected={selected.includes(p.id)} onClick={() => toggle(p.id)} />)}
              </div>
              <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground"><div className="h-px flex-1 bg-border" />AI-generated personas<div className="h-px flex-1 bg-border" /></div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5"><Sparkles size={16} className="text-primary" /><div className="flex flex-col"><span className="text-sm font-semibold text-foreground">Generate personas from the prompt</span><span className="text-xs text-muted-foreground">red_team + edge_case · tailored to this agent · preview-then-approve</span></div></div>
                <button className={btnOutSm} onClick={doGenerate} disabled={genLoading}>
                  {genLoading ? <Loader size={13} className="animate-spin" /> : <Sparkles size={13} />} {genList.length ? 'Regenerate' : 'Generate 3'}
                </button>
              </div>
              {genErr && <div className="mt-2 text-xs text-destructive">{genErr}</div>}
              {genList.length > 0 && (
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {genList.map((p) => (
                    <div key={p.id} className="relative">
                      <span className="absolute right-2 top-2 z-10 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">AI</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); if (!savedGen.includes(p.id)) saveGen(p) }}
                        className={cn('absolute bottom-2 right-2 z-10 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                          savedGen.includes(p.id) ? 'border-success/40 bg-success/10 text-success' : 'border-border bg-card text-muted-foreground hover:text-foreground')}>
                        {savedGen.includes(p.id) ? 'Saved ✓' : 'Save to library'}
                      </button>
                      <PersonaCard p={p} selected={selGen.includes(p.id)} onClick={() => toggleGen(p.id)} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>
        <div className="flex flex-col gap-5 lg:sticky lg:top-4">
          <Card>
            <CardHead><CardTitle>Rubric &amp; judge</CardTitle></CardHead>
            <div className="p-4">
              <div className="mb-3">
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Rubric</label>
                <select value={rubricId} onChange={(e) => onRubricChange(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring">
                  {rubrics.length === 0 && <option>builtin · 7-axis</option>}
                  {rubrics.map((r) => <option key={r.id} value={r.id}>{r.name}{r.builtin ? ' · builtin' : ''}</option>)}
                </select>
                {selectedRubric && (
                  <div className="mt-2 flex flex-col gap-1">
                    {selectedRubric.criteria.map((c) => (
                      <div key={c.name} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                        <Check size={12} className="mt-0.5 shrink-0 text-success" />
                        <span><span className="font-medium text-foreground">{c.name}</span>{c.question ? ` — ${c.question}` : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="mb-3.5 flex flex-col gap-2 text-sm">
                {[['Pass threshold', `${threshold} / 100`], ['Judge model', 'gpt-4o'], ['Levels', 'flow·agent·task·node'], ['Parallelism', '5']].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between"><span className="text-muted-foreground">{k}</span><span className="font-mono text-xs text-foreground">{v}</span></div>
                ))}
              </div>
              <input type="range" min={40} max={95} value={threshold} onChange={(e) => setThreshold(+e.target.value)} className="w-full accent-[hsl(var(--primary))]" />
              <div className="mt-2 text-xs text-muted-foreground">Verdicts are produced by the LiveKit-native leveled judge — the same one used in CI evals and production monitoring.</div>
            </div>
          </Card>
          {isVoice && (
            <Card>
              <CardHead><CardTitle>Voice target</CardTitle></CardHead>
              <div className="p-4">
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Phone number to dial</label>
                <input value={phoneNo} onChange={(e) => setPhoneNo(e.target.value)} placeholder="+1 555 000 0000"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring" />
                <div className="mt-2 text-[11px] text-muted-foreground">
                  {mode === 'voice'
                    ? 'Each persona places a real call to this number (Plivo charge).'
                    : 'Text runs first; failed personas can be escalated to real calls to this number.'}
                </div>
              </div>
            </Card>
          )}
          <button className={cn(btnPrimary, 'h-12 text-[15px]')} onClick={run} disabled={needsPhone}><Play size={17} /> {mode === 'voice' ? 'Place calls' : 'Run simulation'}</button>
          {needsPhone && <div className="text-center text-xs text-warning">Enter a phone number for {mode} mode.</div>}
          <div className="text-center text-xs text-muted-foreground">{selected.length + chosenGen.length} conversations · mode <span className="font-mono">{mode}</span></div>
        </div>
      </div>
    </div>
  )
}

/* ---------- Run (drives the API call) ---------- */
function RunningPhase({ config, result, error, onDone, onBack, onCancel }: { config: RunConfig; result: SimResult | null; error: string | null; onDone: () => void; onBack: () => void; onCancel: () => void }) {
  const combined = [...PERSONAS.filter((p) => config.personaIds.includes(p.id)), ...(config.personas ?? [])]
  const list = combined.length ? combined : PERSONAS
  const [clock, setClock] = useState(0)
  const advanced = useRef(false)
  useEffect(() => {
    const t0 = Date.now()
    const iv = setInterval(() => setClock(Date.now() - t0), 80)
    return () => clearInterval(iv)
  }, [])
  // auto-advance once the result is in AND a minimum animation has played
  useEffect(() => {
    if (result && clock > 2200 && !advanced.current) { advanced.current = true; onDone() }
  }, [result, clock, onDone])

  const finish = (i: number) => 1400 + i * 500
  const states = list.map((_, i) => {
    const prog = result ? 100 : Math.min(92, Math.round((clock / finish(i)) * 100))
    if (result) return { status: 'running' as const, prog: 100, meta: 'Judged' }
    const meta = prog < 25 ? 'Connecting…' : prog < 60 ? 'In conversation…' : 'Judging turns…'
    return { status: 'running' as const, prog, meta }
  })

  if (error) {
    return (
      <div className="animate-in fade-in duration-300">
        <PageHeader title="Simulation failed" sub="The run could not complete." actions={<button className={btnOut} onClick={onBack}><RotateCw size={15} /> Back to setup</button>} />
        <Card><div className="flex items-start gap-3 p-5"><TriangleAlert size={18} className="mt-0.5 text-destructive" /><div className="text-sm text-foreground">{error}</div></div></Card>
      </div>
    )
  }

  return (
    <div className="animate-in fade-in duration-300">
      <PageHeader title={<span className="flex items-center gap-2.5">Running simulation <StatusBadge status="live" /></span>}
        sub={`Driving ${list.length} persona conversations · mode ${config.mode}`}
        actions={!result && <button className={btnOut} onClick={onCancel}><X size={15} /> Cancel simulation</button>} />
      <Stepper phase="running" />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <Card>
          <CardHead><CardTitle>Personas</CardTitle><CardSub>parallelism 5</CardSub></CardHead>
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">{list.map((p, i) => <PersonaCard key={p.id} p={p} state={states[i]} />)}</div>
        </Card>
        <Card className="lg:sticky lg:top-4">
          <CardHead><Loader size={16} className="animate-spin text-primary" /><CardTitle>Running the judge</CardTitle></CardHead>
          <div className="flex flex-col gap-3 p-5 text-sm text-muted-foreground">
            <div>Each persona converses with the agent, then the leveled judge scores it at flow · agent · task · node.</div>
            <div className="flex items-center gap-2"><span className="size-2 animate-pulse rounded-full bg-primary" /> {result ? 'Complete — opening report…' : 'Judging in progress…'}</div>
          </div>
        </Card>
      </div>
    </div>
  )
}

function severityBadge(sev: Severity) {
  return <StatusBadge status={({ critical: 'fail', high: 'warn', medium: 'info' } as const)[sev]} />
}

/* ---------- Report ---------- */
function ReportPhase({ result, onRerun }: { result: SimResult; onRerun: () => void }) {
  const navigate = useNavigate()
  const cases = result.cases
  const worstIdx = cases.reduce((best, c, i) => (c.score < cases[best].score ? i : best), 0)
  const [sel, setSel] = useState(worstIdx)
  const [hl, setHl] = useState<number | null>(null)
  const tref = useRef<Record<number, HTMLDivElement | null>>({})
  const jump = (turn: number) => {
    setSel(worstIdx); setHl(turn)
    setTimeout(() => tref.current[turn]?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60)
    setTimeout(() => setHl(null), 2600)
  }
  const kase = cases[sel]

  return (
    <div className="animate-in fade-in duration-300">
      <PageHeader title="Simulation report"
        sub={<><span className="font-medium text-foreground">{result.agentName}</span> · {cases.length} personas · mode <span className="font-mono">{result.mode}</span> · <span className="font-mono">{result.runId}</span></>}
        actions={<>
          {result.engine === 'demo'
            ? <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-1 text-xs font-medium text-warning" title={result.note}><TriangleAlert size={13} /> Demo data</span>
            : <span className="inline-flex items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-1 text-xs font-medium text-success"><span className="size-1.5 rounded-full bg-current" /> Live judge</span>}
          <button className={btnOut}><Download size={15} /> Export</button>
          <button className={btnOut} disabled={!result.evalRunId} onClick={() => result.evalRunId && navigate(`/evals/${result.evalRunId}`)}><GitPullRequest size={15} /> Open as eval</button>
          <button className={btnPrimary} onClick={onRerun}><RotateCw size={15} /> Re-run</button>
        </>} />

      {result.note && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3.5 py-2.5 text-sm text-foreground">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning" /><span>{result.note}</span>
        </div>
      )}

      <Card className="mb-5">
        <CardHead><CardTitle>Run result</CardTitle><CardSub>{result.agentName} · {cases.length} personas</CardSub><div className="flex-1" /><StatusBadge status={result.passN >= cases.length * 0.7 ? 'pass' : 'fail'} /></CardHead>
        <div className="grid grid-cols-1 gap-6 p-5 md:grid-cols-[auto_1fr] md:items-center">
          <div className="flex items-center gap-4">
            <ScoreRing score={result.overall} size={92} stroke={8} showMax />
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2"><StatusBadge status="pass" /><span className="text-sm text-muted-foreground">{result.passN} passed</span><StatusBadge status="fail" /><span className="text-sm text-muted-foreground">{cases.length - result.passN} failed</span></div>
              <div className="text-sm text-muted-foreground">Pass threshold <b className="text-foreground">{result.threshold}</b>{result.rubricName && <> · rubric <b className="text-foreground">{result.rubricName}</b></>}</div>
              <div className="text-sm text-muted-foreground">Judge levels <span className="font-mono">flow · agent · task · node</span></div>
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">7-axis rubric</div>
            {result.rubricAxes.map((a) => (
              <div key={a.name} className="flex items-center gap-3 py-0.5">
                <span className="w-44 shrink-0 text-sm text-foreground">{a.name}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full', scoreBar(a.score))} style={{ width: `${a.score}%` }} /></div>
                <span className={cn('w-7 text-right text-sm font-semibold tabular-nums', scoreText(a.score))}>{a.score}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <div className="mb-5"><JudgeCard tree={result.judgeTree} onJump={jump} /></div>

      <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <Card>
          <CardHead><CardTitle>Cases</CardTitle><CardSub>{cases.length} persona conversations</CardSub></CardHead>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-left text-xs text-muted-foreground"><th className="px-4 py-2 font-medium">Persona</th><th className="px-4 py-2 font-medium">Type</th><th className="px-4 py-2 font-medium">Result</th><th className="px-4 py-2 text-right font-medium">Score</th><th className="px-4 py-2 text-right font-medium">Turns</th></tr></thead>
            <tbody>
              {cases.map((c, i) => (
                <tr key={i} onClick={() => { setSel(i); setHl(null) }} className={cn('cursor-pointer border-b border-border/60 hover:bg-muted/40', sel === i ? 'bg-muted/60' : '')}>
                  <td className="px-4 py-2.5"><div className="flex items-center gap-2.5"><span className="flex size-6 items-center justify-center rounded-md text-[11px] font-semibold text-white" style={{ background: c.avatar }}>{initials(c.personaName)}</span>{c.personaName}</div></td>
                  <td className="px-4 py-2.5"><span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{c.personaType.replace('_', ' ')}</span></td>
                  <td className="px-4 py-2.5"><StatusBadge status={c.status} /></td>
                  <td className={cn('px-4 py-2.5 text-right font-semibold tabular-nums', scoreText(c.score))}>{c.score}</td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground">{c.turns}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card className="lg:sticky lg:top-4">
          <CardHead><div className="flex size-6 items-center justify-center rounded-md text-[11px] font-semibold text-white" style={{ background: kase.avatar }}>{initials(kase.personaName)}</div><div className="flex flex-col"><CardTitle>{kase.personaName}</CardTitle><CardSub>{kase.summary}</CardSub></div><div className="flex-1" /><StatusBadge status={kase.status} /></CardHead>
          <div className="max-h-[62vh] overflow-auto p-4"><Transcript turns={kase.transcript} highlight={hl} refMap={tref} /></div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Card>
          <CardHead><AlertOctagon size={17} className="text-destructive" /><CardTitle>Worst moments</CardTitle></CardHead>
          <div className="flex flex-col divide-y divide-border/60">
            {result.worstMoments.length === 0 && <div className="px-4 py-3 text-sm text-muted-foreground">No failing cases — nothing flagged.</div>}
            {result.worstMoments.map((w, i) => (
              <div key={i} className="flex flex-col gap-1.5 px-4 py-3"><div className="flex items-center gap-2.5"><ScopeTag scope={w.scope} />{severityBadge(w.sev)}<span className="text-xs text-muted-foreground">{w.case}</span></div><div className="text-sm text-foreground">{w.text}</div></div>
            ))}
          </div>
        </Card>
        <Card>
          <CardHead><Wrench size={17} className="text-primary" /><CardTitle>Recommended fixes</CardTitle><div className="flex-1" /><button className={btnOutSm}><CopyIcon size={13} /> Copy</button></CardHead>
          <div className="flex flex-col divide-y divide-border/60">
            {result.fixes.map((f, i) => (
              <div key={i} className="flex gap-3 px-4 py-3"><span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">{i + 1}</span><div><div className="text-sm font-semibold text-foreground">{f.title}</div><div className="text-sm text-muted-foreground">{f.body}</div></div></div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}

/* ---------- controller ---------- */
export function SimulatePage() {
  const [phase, setPhase] = useState<'setup' | 'running' | 'report'>('setup')
  const [config, setConfig] = useState<RunConfig | null>(null)
  const [result, setResult] = useState<SimResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Set on refresh when a synchronous text sim was interrupted mid-flight: it has
  // no server handle to re-attach to, so we offer a one-click re-run instead.
  const [resumable, setResumable] = useState<RunConfig | null>(null)
  const abortRef = useRef<AbortController | null>(null) // in-flight text-sim fetch, for Cancel
  const navigate = useNavigate()

  // Real calls live in the Live tab — voice / escalation hand off there, prefilled.
  const voicePayload = (c: RunConfig, personas: Persona[]) => ({
    prompt: c.prompt ?? '',
    personas,
    criteria: (c.rubric?.criteria ?? []).map((cr) => ({ name: cr.name, question: cr.question })),
    phoneNumber: c.phoneNumber,
    rubricId: c.rubric?.id,
    rubricName: c.rubric?.name,
  })

  const run = (c: RunConfig) => {
    abortRef.current?.abort() // drop any in-flight run before starting a new one
    if (c.mode === 'voice') {
      // hand off to Live (real calls), prefilled + auto-placed — keeps Simulate text-only
      navigate('/live', { state: { voiceFromSimulate: voicePayload(c, c.personas ?? []) } })
      return
    }
    setConfig(c); setResult(null); setError(null); setResumable(null)
    clearSimRun(); writeSimRun({ config: c }) // record the running intent
    setPhase('running')         // text + text_then_voice run the text sim first
    const ac = new AbortController(); abortRef.current = ac
    runSimulation(c, ac.signal)
      .then((r) => { setResult(r); writeSimRun({ config: c, lastResult: r }) }) // snapshot — server keeps no SimResult
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message) }) // ignore user-cancelled aborts
  }

  // Cancel an in-progress text simulation mid-run and return to setup (no waiting
  // for the diagnostic to finish). Aborts the fetch so the client stops listening.
  const cancel = () => {
    abortRef.current?.abort(); abortRef.current = null
    clearSimRun()
    setResult(null); setError(null); setResumable(null); setPhase('setup')
  }

  const failedPersonas = (): Persona[] =>
    (!config || !result) ? [] : (config.personas ?? []).filter((p) => result.cases.some((cc) => cc.pid === p.id && cc.status === 'fail'))
  // Escalate the failed personas to real calls — handed off to the Live tab.
  const escalate = () => { if (config) navigate('/live', { state: { voiceFromSimulate: voicePayload(config, failedPersonas()) } }) }

  const location = useLocation()
  const started = useRef(false)

  // Survive a browser refresh: restore a finished text report from its snapshot
  // (the server keeps no SimResult). A text sim interrupted mid-flight has no
  // server handle → offer a one-click re-run rather than fake a recovered run.
  useEffect(() => {
    const sc = (location.state as { scenario?: { name: string; yaml: string } } | null)?.scenario
    if (sc?.yaml) { clearSimRun(); return } // a fresh scenario navigation wins
    if (started.current) return
    const saved = readSimRun()
    if (!saved) return
    started.current = true
    setConfig(saved.config)
    if (saved.lastResult) { setResult(saved.lastResult); setPhase('report') }
    else setResumable(saved.config)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-run when navigated from Library → Scenarios (Run button).
  useEffect(() => {
    const sc = (location.state as { scenario?: { name: string; yaml: string } } | null)?.scenario
    if (sc?.yaml && !started.current) {
      started.current = true
      run({ yaml: sc.yaml, mode: 'text', personaIds: [], personas: [], autoGen: false, threshold: 70 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  if (phase === 'running' && config) return <RunningPhase config={config} result={result} error={error} onDone={() => setPhase('report')} onBack={() => setPhase('setup')} onCancel={cancel} />
  if (phase === 'report') {
    if (!result) return <SetupPhase onRun={run} /> // text needs a result
    const rerun = () => { clearSimRun(); setResumable(null); setConfig(null); setResult(null); setPhase('setup') }
    const failed = failedPersonas()
    return (
      <div className="flex flex-col gap-6">
        <ReportPhase result={result} onRerun={rerun} />
        {config?.mode === 'text_then_voice' && failed.length > 0 && (
          <Card className="animate-in fade-in duration-300">
            <div className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex items-center gap-2.5 text-sm">
                <Phone size={16} className="shrink-0 text-primary" />
                <span><b>{failed.length}</b> persona{failed.length > 1 ? 's' : ''} failed the text sim — escalate {failed.length > 1 ? 'them' : 'it'} to real phone calls in the Live tab.</span>
              </div>
              <button onClick={escalate} className={btnPrimary}><Phone size={15} /> Escalate to Live calls</button>
            </div>
          </Card>
        )}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {resumable && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/8 px-3.5 py-2.5 text-sm animate-in fade-in duration-300">
          <span className="flex items-center gap-2"><TriangleAlert size={16} className="shrink-0 text-warning" /> Your last simulation was interrupted by a refresh and couldn't be resumed.</span>
          <span className="flex items-center gap-2">
            <button onClick={() => { const c = resumable; setResumable(null); run(c) }} className={btnOutSm}><RotateCw size={13} /> Re-run</button>
            <button onClick={() => { setResumable(null); clearSimRun() }} className={btnOutSm}>Dismiss</button>
          </span>
        </div>
      )}
      <SetupPhase onRun={run} />
    </div>
  )
}
