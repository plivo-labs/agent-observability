/* simulate-page.tsx — the Simulate module: Define → Run → Report.
 * Results come from POST /api/simulations, so they reflect the pasted prompt.
 * The leveled judge (flow → agent → task → node) is the centerpiece. */
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import {
  AlertOctagon, Check, CheckCircle2, ChevronRight, CopyIcon,
  CornerDownRight, Download, FileCode, GitPullRequest, Loader, Phone,
  Play, Plus, RotateCw, Scale, Sparkles, TextCursorInput,
  Timer, TriangleAlert, UploadCloud, Wrench, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DEFAULT_PROMPT, PERSONA_TYPES, PERSONAS, SIM_YAML, generatePersonas, listLibraryPersonas,
  listRubrics, savePersonaToLibrary, startSimulationJob, getSimulationJob, cancelSimulationJob,
  type CaseStatus, type JobState, type JudgeTreeT, type Persona, type PersonaType, type Rubric, type Severity, type SimResult, type Turn,
} from './sim-data'
import { readSimRun, writeSimRun, clearSimRun } from './run-persistence'
import { Transcript } from '@/components/run-detail/transcript'
import { PersonaSelector } from '@/components/run-detail/persona-selector'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/* ---------- helpers ---------- */
const scoreText = (s: number) => (s >= 80 ? 'text-success' : s >= 65 ? 'text-warning' : 'text-destructive')
const scoreStroke = (s: number) => (s >= 80 ? 'hsl(var(--success))' : s >= 65 ? 'hsl(var(--warning))' : 'hsl(var(--destructive))')
const scoreBar = (s: number) => (s >= 80 ? 'bg-success' : s >= 65 ? 'bg-warning' : 'bg-destructive')
const scoreTone = (s: number) => (s >= 80 ? 'is-good' : s >= 65 ? 'is-warn' : 'is-bad')
const initials = (name: string) => name.split(' ').map((w) => w[0]).slice(0, 2).join('')

/* ---------- primitives ---------- */
function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('ao-panel', className)}>{children}</div>
}
function CardHead({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('ao-panel-head', className)}>{children}</div>
}
function CardTitle({ children }: { children: React.ReactNode }) {
  return <span className="ao-panel-title">{children}</span>
}
function CardSub({ children }: { children: React.ReactNode }) {
  return <span className="ao-panel-sub">{children}</span>
}
/* Uniform card head: optional icon + stacked title / muted one-line descriptor.
 * Mirrors run-detail's SectionTitle so every report card reads the same way. */
function SectionHead({ icon, title, hint }: { icon?: React.ReactNode; title: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {icon}
      <div className="flex min-w-0 flex-col leading-tight">
        <CardTitle>{title}</CardTitle>
        {hint && <CardSub>{hint}</CardSub>}
      </div>
    </div>
  )
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
  const map: Record<string, { tone: string; label: string; dot?: boolean }> = {
    pass: { tone: 'is-success', label: 'Pass' },
    fail: { tone: 'is-danger', label: 'Fail' },
    warn: { tone: 'is-warning', label: 'At risk' },
    live: { tone: 'is-accent', label: 'Live', dot: true },
    info: { tone: 'is-accent', label: 'info' },
    neutral: { tone: 'is-neutral', label: status },
  }
  const m = map[status] ?? map.neutral
  return (
    <span className={cn('ao-badge whitespace-nowrap', m.tone, m.dot && 'ao-badge--dot is-pulse')}>
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

function Seg({ options, value, onChange }: { options: { id: string; label: React.ReactNode; disabled?: boolean }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="ao-seg">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => !o.disabled && onChange(o.id)}
          disabled={o.disabled}
          className={cn('ao-seg-item', value === o.id && 'is-active', o.disabled && 'cursor-not-allowed opacity-40')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Stepper({ phase }: { phase: 'setup' | 'running' | 'report' }) {
  const steps = [
    { id: 'setup', label: 'Define', hint: 'Prompt · personas · rubric' },
    { id: 'running', label: 'Run', hint: 'Drive conversations' },
    { id: 'report', label: 'Report', hint: 'Leveled judge verdicts' },
  ]
  const idx = steps.findIndex((s) => s.id === phase)
  return (
    <div className="mb-6 flex flex-wrap items-stretch gap-2.5">
      {steps.map((s, i) => {
        const done = i < idx
        const active = i === idx
        return (
          <div key={s.id} className="flex items-center gap-2.5">
            <div className={cn('flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors',
              active ? 'border-[hsl(var(--link))] bg-[hsl(var(--link)/0.08)] shadow-sm'
                : done ? 'border-border bg-card' : 'border-dashed border-border bg-transparent')}>
              <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold',
                done ? 'bg-[hsl(var(--link))] text-white'
                  : active ? 'border-2 border-[hsl(var(--link))] text-[hsl(var(--link))]'
                    : 'border border-border text-muted-foreground')}>
                {done ? <Check size={13} /> : i + 1}
              </span>
              <div className="flex flex-col leading-tight">
                <span className={cn('text-sm font-semibold', active || done ? 'text-foreground' : 'text-muted-foreground')}>{s.label}</span>
                <span className="hidden text-[11px] text-muted-foreground sm:block">{s.hint}</span>
              </div>
            </div>
            {i < steps.length - 1 && <div className={cn('h-px w-8 shrink-0', done ? 'bg-[hsl(var(--link))]' : 'bg-border')} />}
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

function JudgeCard({ tree, onJump, selName }: {
  tree: JudgeTreeT; onJump: (turn: number) => void; selName: string
}) {
  return (
    <Card>
      <CardHead>
        <SectionHead
          icon={<Scale size={16} className="shrink-0 text-[hsl(var(--link))]" />}
          title={<>Leveled judge · {selName}</>}
          hint="where the agent passed or failed — whole conversation down to a single turn" />
        <span className="ao-badge is-accent shrink-0">LiveKit-native</span>
      </CardHead>
      <div className="border-b border-border px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
        The judge grades the <b className="font-medium text-foreground">whole conversation</b> first, then breaks it down by <b className="font-medium text-foreground">agent</b>, by <b className="font-medium text-foreground">task</b>, and by each individual <b className="font-medium text-foreground">turn</b> (when available) — so you can see exactly where things went wrong. Click any row to expand it.
      </div>
      <JudgeTree tree={tree} onJump={onJump} />
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

function PageHeader({ eyebrow, title, sub, actions }: { eyebrow?: React.ReactNode; title: React.ReactNode; sub: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="ao-hero">
      <div className="min-w-0">
        {eyebrow && <div className="ao-hero-eyebrow">{eyebrow}</div>}
        <h1 className="ao-hero-title">{title}</h1>
        <p className="ao-hero-sub">{sub}</p>
      </div>
      {actions && <div className="ao-hero-actions">{actions}</div>}
    </header>
  )
}

const btnPrimary = 'ao-btn ao-btn--primary'
const btnOut = 'ao-btn ao-btn--outline'
const btnOutSm = 'ao-btn ao-btn--outline ao-btn--sm'

/* Truman-style "Coverage" presets → AO persona-type arrays the generate endpoint takes. */
const COVERAGE_OPTIONS: { id: string; label: string; types: PersonaType[] }[] = [
  { id: 'mixed', label: 'Mixed coverage', types: ['baseline', 'edge_case', 'workflow', 'knowledge', 'red_team'] },
  { id: 'workflow', label: 'Workflow', types: ['workflow'] },
  { id: 'edge', label: 'Edge cases', types: ['edge_case'] },
  { id: 'redteam', label: 'Red teaming', types: ['red_team'] },
  { id: 'knowledge', label: 'Knowledge base', types: ['knowledge'] },
]

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
  const [genCount, setGenCount] = useState(3) // how many AI personas to generate (backend clamps 1–8)
  const [coverage, setCoverage] = useState('mixed') // what kind of personas (Truman-style single Coverage select)
  const [genLang, setGenLang] = useState('en') // language to generate personas in
  const [genDir, setGenDir] = useState('') // optional extra direction folded into the prompt
  const [genOpen, setGenOpen] = useState(false) // the "Generate AI personas" popup form
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
    const cov = COVERAGE_OPTIONS.find((c) => c.id === coverage) ?? COVERAGE_OPTIONS[0]
    let p = tab === 'yaml' ? SIM_YAML : prompt
    const dir = genDir.trim()
    if (dir) p += `\n\nExtra direction for the personas: ${dir}`
    if (genLang && genLang.trim().toLowerCase() !== 'en') p += `\n\nWrite the personas in language: ${genLang.trim()}.`
    setGenLoading(true); setGenErr(null)
    generatePersonas(p, genCount, cov.types)
      .then((r) => { setGenList(r.personas); setSelGen(r.personas.map((p) => p.id)); setGenOpen(false) })
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
      <PageHeader
        eyebrow={<><Sparkles /> Define · Run · Report</>}
        title="New simulation"
        sub="Paste a prompt or upload a YAML, pick personas, and run a persona-driven sweep scored by the leveled judge." />
      <Stepper phase="setup" />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <div className="flex flex-col gap-5">
          <Card>
            <CardHead>
              <div className="flex min-w-0 items-center gap-2.5"><FileCode size={16} className="shrink-0 text-muted-foreground" /><CardTitle>Agent under test</CardTitle></div>
              <Seg value={tab} onChange={setTab} options={[{ id: 'prompt', label: <><TextCursorInput size={14} /> Paste a prompt</> }, { id: 'yaml', label: <><FileCode size={14} /> Upload YAML</> }]} />
            </CardHead>
            <div className="ao-panel-body">
              {tab === 'prompt' ? (
                <div className="flex flex-col gap-3">
                  <div className="ao-field">
                    <label className="ao-label">System prompt</label>
                    <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} className="ao-textarea mono" />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="ao-hint">Or reference a registered <span className="font-mono">agent_id</span> / phone number.</span>
                    <Seg value={mode} onChange={setMode} options={['text', 'voice', 'text_then_voice'].map((m) => ({ id: m, label: <span className="font-mono text-[11px]">{m}</span> }))} />
                  </div>
                </div>
              ) : (
                <div>
                  <div className="ao-empty mb-3.5">
                    <div className="ao-empty-icon"><UploadCloud /></div>
                    <div className="ao-empty-title">Drop <span className="font-mono">sim.yaml</span> here</div>
                    <div className="ao-empty-text">Validated with Zod · friendly per-field errors · maps 1:1 onto a reusable scenario</div>
                  </div>
                  <YamlBlock src={SIM_YAML} />
                </div>
              )}
            </div>
          </Card>
          <Card>
            <CardHead>
              <div className="flex min-w-0 items-center gap-2.5"><CardTitle>Personas</CardTitle><CardSub>{selected.length + chosenGen.length} selected</CardSub></div>
              <button className={btnOutSm}><Plus size={13} /> New persona</button>
            </CardHead>
            <div className="ao-panel-body">
              <div className="mb-3.5 flex flex-wrap gap-1.5">
                {['all', ...PERSONA_TYPES].map((t) => (
                  <span key={t} onClick={() => setTypeFilter(t)}
                    className={cn('cursor-pointer rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                      typeFilter === t ? 'bg-[hsl(var(--link))] text-white' : 'bg-muted text-muted-foreground hover:text-foreground')}>{t === 'all' ? 'All' : t.replace('_', ' ')}</span>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {filtered.map((p) => <PersonaCard key={p.id} p={p} selected={selected.includes(p.id)} onClick={() => toggle(p.id)} />)}
              </div>
              <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground"><div className="h-px flex-1 bg-border" />AI-generated personas<div className="h-px flex-1 bg-border" /></div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5"><Sparkles size={16} className="text-[hsl(var(--link))]" /><div className="flex flex-col"><span className="text-sm font-semibold text-foreground">Generate personas from the prompt</span><span className="text-xs text-muted-foreground">tailored to this agent · preview-then-approve</span></div></div>
                <button className={btnOutSm} onClick={() => setGenOpen(true)} disabled={genLoading}>
                  {genLoading ? <Loader size={13} className="animate-spin" /> : <Sparkles size={13} />} {genList.length ? 'Regenerate' : 'Generate AI personas'}
                </button>
              </div>
              {genErr && !genOpen && <div className="ao-error mt-2">{genErr}</div>}

              <Dialog open={genOpen} onOpenChange={setGenOpen}>
                <DialogContent className="sm:max-w-2xl">
                  <DialogHeader>
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[hsl(var(--success))]">Personas · {tab === 'yaml' ? 'from YAML' : 'from prompt'}</span>
                    <DialogTitle className="text-xl font-semibold uppercase tracking-tight">Auto-generate personas</DialogTitle>
                    <DialogDescription>Reads your agent prompt and drafts test personas. Preview and approve before they run.</DialogDescription>
                  </DialogHeader>
                  <div className="flex flex-col gap-4">
                    <div className="grid gap-4 sm:grid-cols-[110px_1fr_90px]">
                      <div className="ao-field">
                        <label className="ao-label">How many</label>
                        <input type="number" min={1} max={8} value={genCount}
                          onChange={(e) => setGenCount(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                          className="ao-input mono" />
                      </div>
                      <div className="ao-field">
                        <label className="ao-label">Coverage</label>
                        <select value={coverage} onChange={(e) => setCoverage(e.target.value)} className="ao-input">
                          {COVERAGE_OPTIONS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </select>
                      </div>
                      <div className="ao-field">
                        <label className="ao-label">Language</label>
                        <input value={genLang} onChange={(e) => setGenLang(e.target.value)} placeholder="en" className="ao-input" />
                      </div>
                    </div>
                    <div className="ao-field">
                      <label className="ao-label">Extra direction</label>
                      <textarea value={genDir} onChange={(e) => setGenDir(e.target.value)} rows={4}
                        placeholder="Optional: focus on refunds, booking changes, compliance objections, tool failures…"
                        className="ao-textarea" />
                    </div>
                    {genErr && <div className="ao-error">{genErr}</div>}
                    <div>
                      <button className="ao-btn ao-btn--sm font-mono uppercase tracking-[0.12em]"
                        style={{ background: 'hsl(var(--warning) / 0.12)', borderColor: 'hsl(var(--warning) / 0.4)', color: 'hsl(var(--warning))' }}
                        onClick={doGenerate} disabled={genLoading}>
                        {genLoading ? <Loader size={13} className="animate-spin" /> : <Sparkles size={13} />} Generate {genCount} {genCount === 1 ? 'persona' : 'personas'}
                      </button>
                    </div>
                  </div>
                  <DialogFooter>
                    <button className={btnOutSm} onClick={() => setGenOpen(false)} disabled={genLoading}>Close</button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              {genList.length > 0 && (
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {genList.map((p) => (
                    <div key={p.id} className="relative">
                      <span className="absolute right-2 top-2 z-10 rounded-full bg-[hsl(var(--link)/0.15)] px-1.5 py-0.5 text-[10px] font-semibold text-[hsl(var(--link))]">AI</span>
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
            <CardHead><div className="flex min-w-0 items-center gap-2.5"><Scale size={16} className="shrink-0 text-muted-foreground" /><CardTitle>Rubric &amp; judge</CardTitle></div></CardHead>
            <div className="ao-panel-body">
              <div className="ao-field mb-3">
                <label className="ao-label">Rubric</label>
                {rubrics.length === 0 ? (
                  <Select value="__builtin" disabled>
                    <SelectTrigger className="w-full"><SelectValue placeholder="builtin · 7-axis" /></SelectTrigger>
                    <SelectContent><SelectItem value="__builtin">builtin · 7-axis</SelectItem></SelectContent>
                  </Select>
                ) : (
                  <Select value={rubricId} onValueChange={onRubricChange}>
                    <SelectTrigger className="w-full"><SelectValue placeholder="Select a rubric" /></SelectTrigger>
                    <SelectContent>
                      {rubrics.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}{r.builtin ? ' · builtin' : ''}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                {selectedRubric && (
                  <div className="mt-1 flex flex-col gap-1">
                    {selectedRubric.criteria.map((c) => (
                      <div key={c.name} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                        <Check size={12} className="mt-0.5 shrink-0 text-success" />
                        <span><span className="font-medium text-foreground">{c.name}</span>{c.question ? ` — ${c.question}` : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="mb-3.5 flex flex-col gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm">
                {[['Pass threshold', `${threshold} / 100`], ['Judge model', 'gpt-4o'], ['Levels', 'flow·agent·task·node'], ['Parallelism', '5']].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between"><span className="text-muted-foreground">{k}</span><span className="ao-mono text-xs text-foreground">{v}</span></div>
                ))}
              </div>
              <label className="ao-label mb-1.5 flex items-center justify-between">Pass threshold <span className="ao-mono text-foreground">{threshold}</span></label>
              <input type="range" min={40} max={95} value={threshold} onChange={(e) => setThreshold(+e.target.value)} className="w-full accent-[hsl(var(--link))]" />
              <div className="ao-hint mt-2">Verdicts are produced by the LiveKit-native leveled judge — the same one used in CI evals and production monitoring.</div>
            </div>
          </Card>
          {isVoice && (
            <Card>
              <CardHead><div className="flex min-w-0 items-center gap-2.5"><Phone size={16} className="shrink-0 text-muted-foreground" /><CardTitle>Voice target</CardTitle></div></CardHead>
              <div className="ao-panel-body">
                <div className="ao-field">
                  <label className="ao-label">Phone number to dial <span className="req">*</span></label>
                  <input value={phoneNo} onChange={(e) => setPhoneNo(e.target.value)} placeholder="+1 555 000 0000" className="ao-input mono" />
                  <span className="ao-hint">
                    {mode === 'voice'
                      ? 'Each persona places a real call to this number (Plivo charge).'
                      : 'Text runs first; failed personas can be escalated to real calls to this number.'}
                  </span>
                </div>
              </div>
            </Card>
          )}
          <button className={cn(btnPrimary, 'h-12 text-[15px]')} onClick={run} disabled={needsPhone}><Play size={17} /> {mode === 'voice' ? 'Place calls' : 'Run simulation'}</button>
          {needsPhone && <div className="ao-error text-center text-warning">Enter a phone number for {mode} mode.</div>}
          <div className="text-center text-xs text-muted-foreground">{selected.length + chosenGen.length} conversations · mode <span className="font-mono">{mode}</span></div>
        </div>
      </div>
    </div>
  )
}

/* ---------- Run (live-streaming transcript) ---------- */
export interface LiveCase {
  index: number
  personaName: string
  personaType: string
  status: 'running' | CaseStatus
  score?: number
  turns: Turn[]
}

function RunningPhase({ config, live, startedAt, result, error, onDone, onBack, onCancel }: {
  config: RunConfig; live: LiveCase[]; startedAt: number | null; result: SimResult | null; error: string | null
  onDone: () => void; onBack: () => void; onCancel: () => void
}) {
  // Personas we expect (used before the stream's `start` event populates `live`).
  const combined = [...PERSONAS.filter((p) => config.personaIds.includes(p.id)), ...(config.personas ?? [])]
  const fallback = combined.length ? combined : PERSONAS
  const cases: LiveCase[] = live.length
    ? live
    : fallback.map((p, i) => ({ index: i, personaName: p.name, personaType: p.type, status: 'running' as const, turns: [] }))

  const [sel, setSel] = useState(0)
  const [clock, setClock] = useState(0)
  const advanced = useRef(false)
  const tref = useRef<Record<number, HTMLDivElement | null>>({})
  // Auto-scroll the selected live transcript to the newest turn.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const selTurns = cases[sel]?.turns ?? []
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [selTurns.length, sel])

  // Elapsed timer seeded from the job's server-side start time, so a refresh /
  // tab-switch resumes from the real elapsed instead of restarting at 0. Frozen
  // the moment the result lands — don't keep ticking.
  useEffect(() => {
    if (result) return
    const t0 = startedAt ?? Date.now()
    setClock(Math.max(0, Date.now() - t0)) // seed immediately (no 0.0 flash on resume)
    const iv = setInterval(() => setClock(Math.max(0, Date.now() - t0)), 80)
    return () => clearInterval(iv)
  }, [result, startedAt])
  // Advance to the report as soon as the result arrives (tiny grace so the
  // "Complete" state is visible for a beat — no artificial minimum runtime).
  useEffect(() => {
    if (result && !advanced.current) {
      advanced.current = true
      const t = setTimeout(onDone, 300)
      return () => clearTimeout(t)
    }
  }, [result, onDone])

  if (error) {
    return (
      <div className="animate-in fade-in duration-300">
        <PageHeader eyebrow={<><TriangleAlert /> Run failed</>} title="Simulation failed" sub="The run could not complete." actions={<button className={btnOut} onClick={onBack}><RotateCw size={15} /> Back to setup</button>} />
        <Card><div className="ao-alert is-danger m-4"><TriangleAlert size={16} /><div className="text-sm">{error}</div></div></Card>
      </div>
    )
  }

  const elapsed = (clock / 1000).toFixed(1)
  const doneN = cases.filter((c) => c.status !== 'running').length
  const sub = cases[sel]
  const subTone = sub?.status === 'pass' ? 'pass' : sub?.status === 'fail' ? 'fail' : 'live'

  return (
    <div className="animate-in fade-in duration-300">
      <PageHeader eyebrow={<><Loader className="animate-spin" /> Running</>}
        title={<span className="flex items-center gap-2.5">Running simulation <StatusBadge status="live" /></span>}
        sub={`Driving ${cases.length} persona conversations · mode ${config.mode}`}
        actions={!result && <button className={btnOut} onClick={onCancel}><X size={15} /> Cancel simulation</button>} />
      <Stepper phase="running" />
      <div className="ao-stat-row ao-stagger mb-5">
        <div className="ao-stat ao-stat--feature is-accent">
          <div className="ao-stat-label"><Play size={14} /> Conversations</div>
          <div className="ao-stat-value">{cases.length}</div>
        </div>
        <div className="ao-stat">
          <div className="ao-stat-label"><CheckCircle2 size={14} /> Completed</div>
          <div className="ao-stat-value">{doneN}<span className="unit">/{cases.length}</span></div>
        </div>
        <div className="ao-stat">
          <div className="ao-stat-label"><Timer size={14} /> Elapsed</div>
          <div className="ao-stat-value">{elapsed}<span className="unit">s</span></div>
        </div>
        <div className="ao-stat">
          <div className="ao-stat-label"><Scale size={14} /> Mode</div>
          <div className="ao-stat-value font-mono" style={{ fontSize: 18 }}>{config.mode}</div>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_1.6fr] lg:items-start">
        {/* persona selector — each row shows live status */}
        <Card className="lg:sticky lg:top-4">
          <CardHead><div className="flex min-w-0 items-center gap-2.5"><CardTitle>Personas</CardTitle><CardSub>parallelism 5</CardSub></div></CardHead>
          <div className="flex flex-col gap-2 p-3">
            {cases.map((c) => {
              const tone = c.status === 'pass' ? 'pass' : c.status === 'fail' ? 'fail' : 'live'
              return (
                <button key={c.index} onClick={() => setSel(c.index)}
                  className={cn('flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all',
                    sel === c.index ? 'border-primary ring-1 ring-primary bg-primary/5' : 'border-border hover:bg-accent')}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-foreground">{c.personaName}</div>
                    <div className="text-xs text-muted-foreground">{c.personaType.replace('_', ' ')} · {c.turns.length} turns</div>
                  </div>
                  {c.status === 'running'
                    ? <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Loader size={12} className="animate-spin" /> live</span>
                    : <div className="flex items-center gap-2"><StatusBadge status={tone} />{c.score != null && <ScoreRing score={c.score} size={36} stroke={4} />}</div>}
                </button>
              )
            })}
          </div>
        </Card>
        {/* live transcript for the selected persona */}
        <Card>
          <CardHead>
            <div className="flex min-w-0 items-center gap-2.5">
              <CardTitle>Transcript · {sub?.personaName ?? '—'}</CardTitle>
              <CardSub>{selTurns.length} turns · {elapsed}s</CardSub>
            </div>
            <StatusBadge status={subTone} />
          </CardHead>
          <div ref={scrollRef} className="max-h-[64vh] overflow-auto p-4">
            {selTurns.length === 0
              ? <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader size={14} className="animate-spin" /> {result ? 'Complete — opening report…' : 'Waiting for the conversation to start…'}</div>
              : <Transcript turns={selTurns} refMap={tref} />}
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
  const [copied, setCopied] = useState(false)
  const tref = useRef<Record<number, HTMLDivElement | null>>({})
  const copyFixes = () => {
    const text = result.fixes.map((f, i) => `${i + 1}. ${f.title}\n${f.body}`).join('\n\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }
  const jump = (turn: number) => {
    setSel(worstIdx); setHl(turn)
    setTimeout(() => tref.current[turn]?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60)
    setTimeout(() => setHl(null), 2600)
  }
  const kase = cases[sel]

  const failN = cases.length - result.passN
  const passRate = cases.length ? Math.round((result.passN / cases.length) * 100) : 0

  return (
    <div className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={<><Scale /> Report · {result.runId}</>}
        title="Simulation report"
        sub={<><span className="font-medium text-foreground">{result.agentName}</span> · {cases.length} personas · mode <span className="font-mono">{result.mode}</span></>}
        actions={<>
          {result.engine === 'demo'
            ? <span className="ao-badge is-warning" title={result.note}><TriangleAlert size={13} /> Demo data</span>
            : <span className="ao-badge is-success ao-badge--dot">Live judge</span>}
          <button className={btnOut}><Download size={15} /> Export</button>
          <button className={btnOut} disabled={!result.evalRunId} onClick={() => result.evalRunId && navigate(`/evals/${result.evalRunId}`)}><GitPullRequest size={15} /> Open as eval</button>
          <button className={btnPrimary} onClick={onRerun}><RotateCw size={15} /> Re-run</button>
        </>} />

      {result.note && (
        <div className="ao-alert is-warning mb-4"><TriangleAlert size={16} /><span>{result.note}</span></div>
      )}

      {/* KPI summary — full width above the two columns */}
      <div className="ao-stat-row ao-stagger mb-5">
        <div className={cn('ao-stat ao-stat--feature', scoreTone(result.overall))}>
          <div className="ao-stat-label"><Scale size={14} /> Overall score</div>
          <div className="ao-stat-value">{result.overall}<span className="suffix">/100</span></div>
          <div className="ao-stat-meta">threshold {result.threshold}</div>
        </div>
        <div className={cn('ao-stat', result.passN >= cases.length * 0.7 ? 'is-good' : 'is-bad')}>
          <div className="ao-stat-label"><CheckCircle2 size={14} /> Pass rate</div>
          <div className="ao-stat-value">{passRate}<span className="unit">%</span></div>
          <div className="ao-stat-meta"><span className="ao-delta-up">{result.passN} pass</span> · <span className="ao-delta-down">{failN} fail</span></div>
        </div>
        <div className="ao-stat">
          <div className="ao-stat-label"><Sparkles size={14} /> Personas</div>
          <div className="ao-stat-value">{cases.length}</div>
          <div className="ao-stat-meta">mode {result.mode}</div>
        </div>
        <div className="ao-stat">
          <div className="ao-stat-label"><Scale size={14} /> Rubric</div>
          <div className="ao-stat-value font-mono" style={{ fontSize: 16 }}>{result.rubricName ?? '7-axis'}</div>
          <div className="ao-stat-meta">flow · agent · task · node</div>
        </div>
      </div>

      {/* Run result — Scorer + Rubric side by side, stretched to equal height */}
      <div className="mb-5 grid grid-cols-1 items-stretch gap-5 lg:grid-cols-2">
        {/* Scorer */}
        <Card className="flex flex-col">
          <CardHead>
            <SectionHead icon={<Scale size={16} className="shrink-0 text-[hsl(var(--link))]" />} title="Scorer" hint="overall pass score vs threshold" />
            <StatusBadge status={result.passN >= cases.length * 0.7 ? 'pass' : 'fail'} />
          </CardHead>
          <div className="ao-panel-body flex flex-1 items-center gap-5">
            <ScoreRing score={result.overall} size={88} stroke={8} showMax />
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2"><StatusBadge status="pass" /><span className="text-sm text-muted-foreground">{result.passN} passed</span><StatusBadge status="fail" /><span className="text-sm text-muted-foreground">{failN} failed</span></div>
              <div className="text-sm text-muted-foreground">Pass threshold <b className="text-foreground tabular-nums">{result.threshold}</b></div>
              <div className="text-sm text-muted-foreground">Levels <span className="font-mono">flow · agent · task · node</span></div>
            </div>
          </div>
        </Card>
        {/* Rubric */}
        <Card className="flex flex-col">
          <CardHead>
            <SectionHead title={<>Rubric · {result.rubricName ?? '7-axis'}</>} hint="per-axis quality breakdown" />
            <span className="ao-panel-sub shrink-0">{result.rubricAxes.length} axes</span>
          </CardHead>
          <div className="ao-panel-body flex flex-1 flex-col justify-center gap-1.5">
            {result.rubricAxes.map((a) => (
              <div key={a.name} className="flex items-center gap-3">
                <span className="w-36 shrink-0 truncate text-sm text-foreground" title={a.name}>{a.name}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full', scoreBar(a.score))} style={{ width: `${a.score}%` }} /></div>
                <span className={cn('w-7 text-right text-sm font-semibold tabular-nums', scoreText(a.score))}>{a.score}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Worst moments — full card only when there are real failures; otherwise render nothing */}
      {result.worstMoments.some((w) => w.sev === 'critical' || w.sev === 'high') && (
        <div className="mb-5">
          <Card>
            <CardHead>
              <SectionHead icon={<AlertOctagon size={16} className="shrink-0 text-destructive" />} title="Worst moments" hint="lowest-scoring turns" />
            </CardHead>
            <div className="flex flex-col divide-y divide-border/60">
              {result.worstMoments.map((w, i) => (
                <div key={i} className="flex flex-col gap-1.5 px-4 py-3.5"><div className="flex flex-wrap items-center gap-2.5"><ScopeTag scope={w.scope} />{severityBadge(w.sev)}<span className="text-xs text-muted-foreground">{w.case}</span></div><div className="text-sm text-foreground">{w.text}</div></div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* Recommended fixes — full-width row */}
      <div className="mb-5">
        <Card>
          <CardHead>
            <SectionHead icon={<Wrench size={16} className="shrink-0 text-[hsl(var(--link))]" />} title="Recommended fixes" hint="suggested prompt / config changes" />
            <button className={btnOutSm} onClick={copyFixes}>{copied ? <Check size={13} /> : <CopyIcon size={13} />} {copied ? 'Copied ✓' : 'Copy'}</button>
          </CardHead>
          <div className="flex flex-col divide-y divide-border/60">
            {result.fixes.map((f, i) => (
              <div key={i} className="flex gap-3 px-4 py-3.5"><span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">{i + 1}</span><div className="flex flex-col gap-0.5"><div className="text-sm font-semibold text-foreground">{f.title}</div><div className="text-sm text-muted-foreground">{f.body}</div></div></div>
            ))}
          </div>
        </Card>
      </div>

      {/* Persona selector — sits right above the per-persona views it drives (leveled judge + transcript) */}
      <PersonaSelector
        label="Persona"
        items={cases.map((c, i) => ({ id: String(i), name: c.personaName, status: c.status === 'pass' ? 'pass' : 'fail', avatar: c.avatar, score: c.score }))}
        selectedId={String(sel)}
        onSelect={(id) => { setSel(Number(id)); setHl(null) }}
      />

      {/* Leveled judge — full-width row, driven by the selected persona */}
      <div className="mb-5">
        <JudgeCard key={sel} tree={kase.judgeTree ?? result.judgeTree} onJump={jump} selName={kase.personaName} />
      </div>

      {/* Transcript — at the bottom (raw detail): full-width transcript for the selected persona */}
      <Card>
        <CardHead>
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-white" style={{ background: kase.avatar }}>{initials(kase.personaName)}</span>
            <div className="flex min-w-0 flex-col leading-tight"><CardTitle>Transcript · {kase.personaName}</CardTitle><CardSub>{kase.turns} turns · {kase.durationS}s</CardSub></div>
          </div>
          <StatusBadge status={kase.status} />
        </CardHead>
        <div className="max-h-[72vh] overflow-auto p-4"><Transcript turns={kase.transcript} highlight={hl} refMap={tref} /></div>
      </Card>
    </div>
  )
}

/* ---------- controller ---------- */
export function SimulatePage() {
  const [phase, setPhase] = useState<'setup' | 'running' | 'report'>('setup')
  const [config, setConfig] = useState<RunConfig | null>(null)
  const [result, setResult] = useState<SimResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Live state: per-case turns + status, driven by polling the server-side job.
  const [live, setLive] = useState<LiveCase[]>([])
  // The job's server-side start time (epoch ms) — seeds the elapsed timer so it
  // resumes from the real elapsed on refresh / tab-switch instead of resetting.
  const [startedAt, setStartedAt] = useState<number | null>(null)
  // Set ONLY when the server has no record of a previously-running job (expired
  // or cleared by a backend restart): there's nothing to resume, so offer a
  // one-click re-run. A normal refresh/nav resumes via the jobId instead.
  const [resumable, setResumable] = useState<RunConfig | null>(null)
  // The active server-side job id (the resume handle) + a poll-loop guard so a
  // single poller runs per job even across re-renders.
  const jobIdRef = useRef<string | null>(null)
  const pollingRef = useRef<string | null>(null)
  const navigate = useNavigate()

  // Map a JobState's cases into the live LiveCase[] the running UI renders.
  const applyJob = (job: JobState) => {
    if (job.startedAt) setStartedAt(job.startedAt) // resume the timer from the real start
    setLive(job.cases.map((c) => ({
      index: c.index,
      personaName: c.personaName,
      personaType: c.personaType,
      status: c.status ?? 'running',
      score: c.score,
      turns: c.turns.map((t) => ({ role: t.role, t: t.t, ms: t.ms ?? undefined, flag: t.flag ?? undefined })),
    })))
  }

  // Poll a server-side job (~1s) until it is done/error, driving the live UI.
  // Safe to call on Run and on mount-resume; a guard keeps one loop per job.
  const pollJob = (jobId: string, c: RunConfig) => {
    if (pollingRef.current === jobId) return
    pollingRef.current = jobId
    jobIdRef.current = jobId
    let stopped = false
    const tick = async () => {
      if (stopped || jobIdRef.current !== jobId) return
      try {
        const job = await getSimulationJob(jobId)
        if (jobIdRef.current !== jobId) return
        applyJob(job)
        if (job.status === 'done' && job.result) {
          setResult(job.result)
          writeSimRun({ config: c, jobId, lastResult: job.result }) // snapshot for instant restore
          pollingRef.current = null
          return
        }
        if (job.status === 'error') {
          setError(job.error ?? 'Simulation failed to run')
          pollingRef.current = null
          return
        }
        if (job.status === 'cancelled') {
          // Cancelled elsewhere (or a resumed run we'd already cancelled) — drop
          // the handle and return to setup, no error banner.
          clearSimRun()
          jobIdRef.current = null
          pollingRef.current = null
          setPhase('setup')
          return
        }
      } catch (e) {
        // 404 → the server truly has no record of this job (expired / restart).
        // THEN, and only then, fall back to the Re-run offer.
        if ((e as { notFound?: boolean })?.notFound) {
          clearSimRun()
          jobIdRef.current = null
          pollingRef.current = null
          setResumable(c)
          setPhase('setup')
          return
        }
        // Transient network error — keep polling.
      }
      setTimeout(tick, 1000)
    }
    void tick()
    // Returned cleanup stops THIS loop (used by Cancel / new run).
    return () => { stopped = true }
  }

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
    jobIdRef.current = null; pollingRef.current = null // drop any in-flight run before starting a new one
    if (c.mode === 'voice') {
      // hand off to Live (real calls), prefilled + auto-placed — keeps Simulate text-only
      navigate('/live', { state: { voiceFromSimulate: voicePayload(c, c.personas ?? []) } })
      return
    }
    setConfig(c); setResult(null); setError(null); setResumable(null); setLive([]); setStartedAt(Date.now())
    clearSimRun()
    setPhase('running')         // text + text_then_voice run the text sim first
    // Start the run on the SERVER so it survives refresh / in-app nav, then poll.
    // Request the full leveled-judge battery — without scopes the backend
    // defaults to ["flow"] and the Leveled judge tree never gets populated.
    startSimulationJob({ ...c, scopes: ['flow', 'agent', 'task', 'node'] })
      .then(({ jobId }) => {
        writeSimRun({ config: c, jobId }) // persist the RESUME handle
        pollJob(jobId, c)
      })
      .catch((e) => setError(e?.message ?? 'Simulation failed to start'))
  }

  // Cancel an in-progress text simulation mid-run and return to setup. Tell the
  // server to abort the background run (best-effort), then drop our handle so it
  // won't resume, and clear the persisted blob.
  const cancel = () => {
    if (jobIdRef.current) void cancelSimulationJob(jobIdRef.current)
    jobIdRef.current = null; pollingRef.current = null
    clearSimRun()
    setResult(null); setError(null); setResumable(null); setLive([]); setStartedAt(null); setPhase('setup')
  }

  const failedPersonas = (): Persona[] =>
    (!config || !result) ? [] : (config.personas ?? []).filter((p) => result.cases.some((cc) => cc.pid === p.id && cc.status === 'fail'))
  // Escalate the failed personas to real calls — handed off to the Live tab.
  const escalate = () => { if (config) navigate('/live', { state: { voiceFromSimulate: voicePayload(config, failedPersonas()) } }) }

  const location = useLocation()
  const started = useRef(false)

  // Survive a browser refresh OR returning to the tab (in-app nav): the run is a
  // SERVER-side job keyed by jobId, so we re-fetch it and resume. running →
  // resume polling + show the running UI; done → show the report; 404 / gone →
  // only THEN fall back to the Re-run offer. A snapshot lastResult short-circuits
  // a finished run for an instant report without a round-trip.
  useEffect(() => {
    const sc = (location.state as { scenario?: { name: string; yaml: string } } | null)?.scenario
    if (sc?.yaml) { clearSimRun(); return } // a fresh scenario navigation wins
    if (started.current) return
    const saved = readSimRun()
    if (!saved) return
    started.current = true
    setConfig(saved.config)

    if (saved.jobId) {
      // Re-attach to the server job. Show the running UI immediately (snapshot
      // lastResult fills the report instantly if it already finished).
      if (saved.lastResult) { setResult(saved.lastResult); setPhase('report') }
      else setPhase('running')
      getSimulationJob(saved.jobId)
        .then((job) => {
          applyJob(job)
          if (job.status === 'done' && job.result) { setResult(job.result); setPhase('report') }
          else if (job.status === 'error') { setError(job.error ?? 'Simulation failed to run'); setPhase('running') }
          else { setPhase('running'); pollJob(saved.jobId!, saved.config) } // still running → resume polling
        })
        .catch((e) => {
          if ((e as { notFound?: boolean })?.notFound) {
            // Server has no record (expired / backend restart) AND no snapshot →
            // offer Re-run. If a snapshot exists we keep showing the report.
            if (!saved.lastResult) { clearSimRun(); setResumable(saved.config); setPhase('setup') }
          }
          // transient error → leave the running UI; the user can refresh again.
        })
      return
    }

    // Legacy blob without a jobId: snapshot report or (interrupted) Re-run offer.
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

  if (phase === 'running' && config) return <RunningPhase config={config} live={live} startedAt={startedAt} result={result} error={error} onDone={() => setPhase('report')} onBack={() => setPhase('setup')} onCancel={cancel} />
  if (phase === 'report') {
    if (!result) return <SetupPhase onRun={run} /> // text needs a result
    const rerun = () => { jobIdRef.current = null; pollingRef.current = null; clearSimRun(); setResumable(null); setConfig(null); setResult(null); setLive([]); setPhase('setup') }
    const failed = failedPersonas()
    return (
      <div className="flex flex-col gap-6">
        <ReportPhase result={result} onRerun={rerun} />
        {config?.mode === 'text_then_voice' && failed.length > 0 && (
          <Card className="animate-in fade-in duration-300">
            <div className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex items-center gap-2.5 text-sm">
                <Phone size={16} className="shrink-0 text-[hsl(var(--link))]" />
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
        <div className="ao-alert is-warning flex-wrap justify-between animate-in fade-in duration-300">
          <span className="flex items-center gap-2"><TriangleAlert size={16} /> Your last simulation is no longer on the server (it expired or the backend restarted) and couldn't be resumed.</span>
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
