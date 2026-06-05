/* live-call-page.tsx — Live calling (TRUMAN model, SHELL).
 * Agent + a rubric + N personas → a SUITE of calls (one call per persona, like
 * Truman). Each call has the real lifecycle, a live transcript, audio legs,
 * takeover ("director on stage"), and a criteria verdict. Drill into any call.
 * Real telephony/audio is served by the Python LiveKit caller (apps/caller). */
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import {
  Activity, AlertTriangle, Bot, Check, FileCode, GitPullRequest, Hand, ListChecks, Loader, Mic, Phone, Radio, RotateCw, Send, Timer, TriangleAlert, Users, Volume2, VolumeX, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DEFAULT_PROMPT, PERSONA_TYPES, PERSONAS, getCallConfig, getSuiteStatus, listAgents, listLibraryPersonas, listRubrics, placeCallBatch,
  type Agent, type CallBatchResult, type LiveMode, type Persona, type Rubric, type Turn,
} from '../simulate/sim-data'
import { useLiveCall } from './use-live-call'
import { AudioPlayer } from '@/components/run-detail/audio-player'
import { readLiveRun, writeLiveRun, clearLiveRun } from '../simulate/run-persistence'

const initials = (n: string) => n.split(' ').map((w) => w[0]).slice(0, 2).join('')
const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

function Waveform({ active, color }: { active: boolean; color: string }) {
  return (
    <div className="flex h-7 items-center gap-[3px]">
      {Array.from({ length: 16 }).map((_, i) => (
        <span key={i} className={cn('w-[3px] rounded-full', active ? 'animate-pulse' : '')} style={{ background: color, height: active ? `${6 + ((i * 5) % 16)}px` : '3px', animationDelay: `${(i % 6) * 90}ms`, opacity: active ? 1 : 0.35 }} />
      ))}
    </div>
  )
}
function AudioLeg({ label, color, speaking, muted, onMute }: { label: string; color: string; speaking: boolean; muted: boolean; onMute: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
      <span className="size-2.5 rounded-full" style={{ background: color, opacity: muted ? 0.3 : 1 }} />
      <span className="w-16 shrink-0 text-xs font-medium text-foreground">{label}</span>
      <div className="flex-1"><Waveform active={speaking && !muted} color={color} /></div>
      <button onClick={onMute} className="rounded p-1 text-muted-foreground hover:text-foreground">{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button>
    </div>
  )
}

export function LiveCallPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const autoPlaced = useRef(false) // guards the Simulate→Live voice hand-off auto-place
  const [phase, setPhase] = useState<'setup' | 'suite'>('setup')
  // setup
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentId, setAgentId] = useState<string>('')
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [personas, setPersonas] = useState<Persona[]>(PERSONAS)
  const [selectedIds, setSelectedIds] = useState<string[]>(PERSONAS.map((p) => p.id))
  const [typeFilter, setTypeFilter] = useState('all')
  const [rubrics, setRubrics] = useState<Rubric[]>([])
  const [rubricId, setRubricId] = useState('')
  const [opener, setOpener] = useState('')
  const [phoneNo, setPhoneNo] = useState('') // user types the target #, or it auto-fills from a Library agent
  const [liveMode, setLiveMode] = useState<LiveMode>('demo')
  const [placing, setPlacing] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // suite
  const [batch, setBatch] = useState<CallBatchResult | null>(null)
  const [clock, setClock] = useState(0)
  const [sel, setSel] = useState(0)
  const [takeover, setTakeover] = useState(false)
  const [draft, setDraft] = useState('')
  const [extra, setExtra] = useState<Record<number, Turn[]>>({})
  const [mutePersona, setMutePersona] = useState(false)
  const [muteAgent, setMuteAgent] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listLibraryPersonas().then((ps) => { if (ps.length) { setPersonas(ps); setSelectedIds(ps.map((p) => p.id)) } }).catch(() => {})
    listRubrics().then((rs) => { if (rs.length) { setRubrics(rs); setRubricId(rs[0].id) } }).catch(() => {})
    listAgents().then((as) => { if (as.length) { setAgents(as) } }).catch(() => {})
    getCallConfig().then((cfg) => setLiveMode(cfg.mode)).catch(() => {})
  }, [])

  // Survive a browser refresh: re-attach to an in-progress suite by suiteId.
  // The suite is DB-backed (getSuiteStatus); the 2s poll effect + per-call
  // useLiveCall both resume off the restored batch with no extra wiring. A
  // gone/404 suite clears the saved handle and falls back to setup.
  useEffect(() => {
    if ((location.state as { voiceFromSimulate?: unknown } | null)?.voiceFromSimulate) return // a fresh hand-off wins
    const saved = readLiveRun()
    if (!saved?.suiteId) return
    setPhoneNo(saved.phoneNo ?? '')
    // restore the elapsed timer from the real start time (the clock interval resumes from here)
    if (saved.startedAt) setClock(Math.max(0, Date.now() - saved.startedAt))
    getSuiteStatus(saved.suiteId)
      .then((s) => { setBatch(s); setPhase('suite') })
      .catch(() => clearLiveRun())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Voice hand-off from the Simulate tab: prefill the form and auto-place the real
  // calls so all live calling happens here (streaming transcript, audio, takeover).
  useEffect(() => {
    const v = (location.state as { voiceFromSimulate?: {
      prompt?: string; personas?: Persona[]; criteria?: { name: string; question: string }[]
      phoneNumber?: string; rubricId?: string; rubricName?: string
    } } | null)?.voiceFromSimulate
    if (!v || autoPlaced.current) return
    autoPlaced.current = true
    setPrompt(v.prompt ?? '')
    setPhoneNo(v.phoneNumber ?? '')
    if (v.personas?.length) { setPersonas(v.personas); setSelectedIds(v.personas.map((p) => p.id)) }
    clearLiveRun() // fresh hand-off supersedes any stale saved suite
    // scrub the navigation state so a refresh doesn't replay the auto-place (the
    // suite persists via writeLiveRun and rehydrates instead).
    navigate('/live', { replace: true, state: null })
    if (!v.phoneNumber?.trim() || !v.personas?.length) {
      setErr('Add a phone number and at least one persona to place calls.')
      return
    }
    setPlacing(true); setErr(null)
    placeCallBatch({ prompt: v.prompt ?? '', personas: v.personas, criteria: v.criteria ?? [], phoneNumber: v.phoneNumber, rubricId: v.rubricId, rubricName: v.rubricName })
      .then((b) => {
        setBatch(b); setClock(0); setSel(0); setTakeover(false); setExtra({}); setPhase('suite')
        if (b.suiteId) writeLiveRun({ suiteId: b.suiteId, phoneNo: v.phoneNumber, startedAt: Date.now() })
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setPlacing(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  // Selecting a library agent fills the prompt + phone; '' is the custom-prompt fallback.
  const onAgentChange = (id: string) => {
    setAgentId(id)
    const a = agents.find((x) => x.id === id)
    if (a) { setPrompt(a.system_prompt); if (a.phone_number) setPhoneNo(a.phone_number) }
  }

  const rubric = rubrics.find((r) => r.id === rubricId)
  const filtered = typeFilter === 'all' ? personas : personas.filter((p) => p.type === typeFilter)
  const toggle = (id: string) => setSelectedIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  const calls = batch?.calls ?? []
  const isTruman = batch?.mode === 'truman'
  // real-mode progress is derived from the Truman lifecycle, not the fake clock.
  const REAL_PROG: Record<string, number> = { queued: 5, dialing: 20, live: 55, recording: 80, evaluating: 92, done: 100, failed: 100 }
  const finish = (i: number) => 1600 + i * 700 + (calls[i]?.transcript.length ?? 4) * 120
  const progOf = (i: number) => isTruman ? (REAL_PROG[calls[i]?.status ?? 'queued'] ?? 5) : Math.min(100, Math.round((clock / finish(i)) * 100))
  const stageOf = (i: number): 'dialing' | 'live' | 'done' => {
    if (isTruman) { const s = calls[i]?.status; return s === 'done' || s === 'failed' ? 'done' : s === 'live' || s === 'recording' || s === 'evaluating' ? 'live' : 'dialing' }
    const p = progOf(i); return p < 8 ? 'dialing' : p < 100 ? 'live' : 'done'
  }
  const isCallDone = (i: number) => isTruman ? (calls[i]?.status === 'done' || calls[i]?.status === 'failed') : progOf(i) >= 100
  const doneCount = calls.filter((_, i) => isCallDone(i)).length
  const suiteDone = calls.length > 0 && (isTruman ? batch?.status === 'done' || doneCount === calls.length : doneCount === calls.length)
  const passN = calls.filter((c) => c.verdict === 'pass').length

  // clock (demo progress + elapsed timer; pauses during takeover)
  useEffect(() => {
    if (phase !== 'suite' || !batch || suiteDone || takeover) return
    const iv = setInterval(() => setClock((c) => c + 120), 120)
    return () => clearInterval(iv)
  }, [phase, batch, suiteDone, takeover])

  // real (Truman) mode: poll the suite until every call is terminal.
  useEffect(() => {
    if (phase !== 'suite' || !batch?.suiteId || suiteDone) return
    const iv = setInterval(async () => {
      try { const s = await getSuiteStatus(batch.suiteId!); setBatch(s) } catch { /* keep last snapshot */ }
    }, 2000)
    return () => clearInterval(iv)
  }, [phase, batch?.suiteId, suiteDone])

  // Drop the saved handle once the suite is terminal so a finished suite doesn't
  // auto-reopen on every future refresh — the current view stays put this session.
  useEffect(() => { if (suiteDone) clearLiveRun() }, [suiteDone])

  const elapsed = Math.floor(clock / 1000)
  const place = async () => {
    const chosen = personas.filter((p) => selectedIds.includes(p.id))
    if (!chosen.length) return
    if (liveMode === 'truman' && !phoneNo.trim()) { setErr('Enter a phone number to place real calls.'); return }
    setPlacing(true); setErr(null)
    try {
      const b = await placeCallBatch({ prompt, personas: chosen, criteria: (rubric?.criteria ?? []).map((c) => ({ name: c.name, question: c.question })), opener: opener.trim() || undefined, phoneNumber: phoneNo.trim(), rubricId: rubric?.id, rubricName: rubric?.name })
      setBatch(b); setClock(0); setSel(0); setTakeover(false); setExtra({}); setPhase('suite')
      // only real/Truman suites are recoverable; startedAt seeds the elapsed timer across a refresh
      if (b.suiteId) writeLiveRun({ suiteId: b.suiteId, phoneNo: phoneNo.trim(), startedAt: Date.now() })
    } catch (e) { setErr((e as Error).message) } finally { setPlacing(false) }
  }

  const c = calls[sel]
  const selStage = c ? stageOf(sel) : 'dialing'
  // Real (Truman) in-call streaming for the selected call while it's in progress.
  const liveRunId = isTruman ? (c?.trumanRunId ?? null) : null
  const liveActive = !!liveRunId && (selStage === 'dialing' || selStage === 'live')
  const live = useLiveCall(liveRunId, liveActive)
  const directorOn = isTruman ? live.takeoverActive : takeover
  // Transcript: stream live turns while the real call runs; otherwise the call's stored transcript.
  const revealedSel = c ? (isTruman ? c.transcript.length : selStage === 'done' ? c.transcript.length : Math.max(1, Math.ceil((progOf(sel) / 100) * c.transcript.length))) : 0
  const liveTurns: Turn[] = liveActive
    ? live.turns.map((t) => (t.role === 'director' ? { role: 'user' as const, t: t.text, flag: 'director' } : { role: t.role === 'user' ? 'user' as const : 'agent' as const, t: t.text }))
    : c ? [...c.transcript.slice(0, revealedSel), ...(extra[sel] ?? [])] : []
  const lastRole = liveTurns.length ? liveTurns[liveTurns.length - 1].role : 'agent'
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [liveTurns.length, revealedSel, extra, sel])

  const sendTakeover = () => { if (!draft.trim()) return; setExtra((m) => ({ ...m, [sel]: [...(m[sel] ?? []), { role: 'user', t: draft.trim(), flag: 'director' }] })); setDraft('') }

  /* ---------- SETUP ---------- */
  if (phase === 'setup') {
    const chosenN = selectedIds.length
    return (
      <div>
        <header className="ao-hero ao-reveal">
          <div>
            <div className="ao-hero-eyebrow"><Radio /> Live calling</div>
            <h1 className="ao-hero-title">Live calls</h1>
            <p className="ao-hero-sub">Run a suite of live calls — one per persona — against your agent, scored by a rubric. Step on stage any time.</p>
          </div>
          <div className="ao-hero-actions">
            {liveMode === 'truman'
              ? <span className="ao-badge is-success ao-badge--dot is-pulse">Real call</span>
              : <span className="ao-badge is-warning ao-badge--dot">Shell · demo</span>}
          </div>
        </header>

        {liveMode === 'truman' ? (
          <div className="ao-alert mb-4 ao-reveal ao-reveal-1">
            <Phone />
            <span><b>Real calls.</b> Each persona places a real phone call to <span className="font-mono">{phoneNo.trim() || 'the number you enter below'}</span> over LiveKit + Plivo; the LiveKit judge scores the recorded transcript against your rubric. Calls run asynchronously — the suite updates live as each finishes. (Dialing needs AO's caller worker running — <span className="font-mono">bun run caller:worker</span>.)</span>
          </div>
        ) : (
          <div className="ao-alert is-warning mb-4 ao-reveal ao-reveal-1">
            <TriangleAlert />
            <span><b>Live-call shell.</b> Real PSTN dialing is served by AO's vendored caller — set <span className="font-mono">TRUMAN_API_URL</span> + run the caller worker to place real calls. Here calls are engine-driven; the suite, lifecycle, transcript, takeover and criteria scoring match a real call.</span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.6fr_1fr] lg:items-start">
          <div className="flex flex-col gap-5 ao-reveal ao-reveal-2">
            <section className="ao-panel">
              <div className="ao-panel-head">
                <div className="ao-panel-title"><Bot /> Agent under test</div>
              </div>
              <div className="ao-panel-body flex flex-col gap-4">
                <div className="ao-field">
                  <label className="ao-label">Agent</label>
                  <div className="relative">
                    <Bot size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <select value={agentId} onChange={(e) => onAgentChange(e.target.value)} className="ao-input w-full" style={{ paddingLeft: '2.25rem' }}>
                      <option value="">Custom prompt</option>
                      {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.builtin ? ' · builtin' : ''}</option>)}
                    </select>
                  </div>
                </div>
                <div className="ao-field">
                  <label className="ao-label">System prompt</label>
                  <textarea value={prompt} onChange={(e) => { setPrompt(e.target.value); setAgentId('') }} rows={6} className="ao-textarea mono w-full" />
                </div>
                <div className="ao-field-row">
                  <div className="ao-field">
                    <label className="ao-label">Phone number {liveMode === 'truman' && <span className="req">*</span>}</label>
                    <input value={phoneNo} onChange={(e) => setPhoneNo(e.target.value)} placeholder="+1 415 555 0142" className="ao-input mono w-full" />
                  </div>
                  <div className="ao-field">
                    <label className="ao-label">Opener override</label>
                    <input value={opener} onChange={(e) => setOpener(e.target.value)} placeholder="auto per persona" className="ao-input w-full" title="The first line each caller speaks when the call connects. Leave blank to use each persona's own opener." />
                    <span className="mt-1 block text-xs text-muted-foreground">First line each caller says when the call connects — blank uses each persona's own opener.</span>
                  </div>
                </div>
              </div>
            </section>

            <section className="ao-panel">
              <div className="ao-panel-head">
                <div>
                  <div className="ao-panel-title"><Users /> Personas</div>
                  <div className="ao-panel-sub">{chosenN} selected — each gets its own call</div>
                </div>
              </div>
              <div className="ao-panel-body">
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {['all', ...PERSONA_TYPES].map((t) => <span key={t} onClick={() => setTypeFilter(t)} className={cn('cursor-pointer rounded-full px-2.5 py-1 text-xs font-medium transition-colors', typeFilter === t ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground')}>{t === 'all' ? 'All' : t.replace('_', ' ')}</span>)}
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {filtered.map((p) => (
                    <button key={p.id} onClick={() => toggle(p.id)} className={cn('flex items-center gap-2.5 rounded-lg border p-2.5 text-left transition-all', selectedIds.includes(p.id) ? 'border-primary ring-1 ring-primary bg-primary/5' : 'border-border opacity-70 hover:opacity-100')}>
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold text-white" style={{ background: p.avatar }}>{initials(p.name)}</div>
                      <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-foreground">{p.name}</div><div className="truncate text-xs text-muted-foreground">{p.type.replace('_', ' ')}</div></div>
                      {selectedIds.includes(p.id) && <Check size={16} className="text-primary" />}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          </div>

          <div className="flex flex-col gap-5 lg:sticky lg:top-4 ao-reveal ao-reveal-3">
            <section className="ao-panel">
              <div className="ao-panel-head">
                <div className="ao-panel-title"><ListChecks /> Rubric</div>
              </div>
              <div className="ao-panel-body">
                <select value={rubricId} onChange={(e) => setRubricId(e.target.value)} className="ao-input w-full">{rubrics.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
                {rubric && <div className="mt-3 flex flex-wrap gap-1">{rubric.criteria.map((c) => <span key={c.name} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground" title={c.question}>{c.name}</span>)}</div>}
                <div className="ao-hint mt-3">Each is a pass/fail criterion — a call passes only if all pass.</div>
              </div>
            </section>

            <button className="ao-btn ao-btn--primary h-12 text-[15px]" onClick={place} disabled={placing || chosenN === 0}>{placing ? <><Loader size={16} className="animate-spin" /> Placing {chosenN} calls…</> : <><Phone size={17} /> Place {chosenN} calls</>}</button>
            {err && <div className="ao-alert is-danger"><AlertTriangle />{err}</div>}
          </div>
        </div>
      </div>
    )
  }

  /* ---------- SUITE ---------- */
  const personaSpeaking = isTruman ? live.legs.persona.speaking : selStage === 'live' && lastRole === 'user' && !takeover
  const agentSpeaking = isTruman ? live.legs.callee.speaking : selStage === 'live' && lastRole === 'agent'
  return (
    <div>
      <header className="ao-hero ao-reveal">
        <div>
          <div className="ao-hero-eyebrow"><Radio /> Live suite</div>
          <h1 className="ao-hero-title flex items-center gap-2.5">{batch?.agentName}{isTruman && <span className="ao-badge is-success ao-badge--dot is-pulse">real call</span>}</h1>
          <p className="ao-hero-sub flex items-center gap-2"><span className="ao-mono">{phoneNo}</span> · <Timer size={13} /> {fmtClock(elapsed)} · {calls.length} calls</p>
        </div>
        <div className="ao-hero-actions">
          {suiteDone
            ? <span className={cn('ao-badge', passN === calls.length ? 'is-success' : 'is-danger')}>{passN}/{calls.length} passed</span>
            : <span className="ao-badge is-accent ao-badge--dot is-pulse">{doneCount}/{calls.length} done</span>}
        </div>
      </header>

      {/* KPI row */}
      <div className="ao-stat-row ao-stagger mb-5">
        <div className="ao-stat ao-stat--feature is-accent">
          <div className="ao-stat-label"><Phone /> Calls placed</div>
          <div className="ao-stat-value">{calls.length}</div>
          <div className="ao-stat-meta">{doneCount} terminal · {Math.max(0, calls.length - doneCount)} in progress</div>
        </div>
        <div className={cn('ao-stat', suiteDone ? (passN === calls.length ? 'is-good' : 'is-bad') : 'is-accent')}>
          <div className="ao-stat-label"><Check /> Passed</div>
          <div className="ao-stat-value">{passN}<span className="suffix">/{calls.length}</span></div>
          <div className="ao-stat-meta">{suiteDone ? 'suite complete' : 'judging in progress'}</div>
        </div>
        <div className="ao-stat is-good">
          <div className="ao-stat-label"><Timer /> Elapsed</div>
          <div className="ao-stat-value font-mono">{fmtClock(elapsed)}</div>
          <div className="ao-stat-meta">{isTruman ? 'real call time' : 'simulated'}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_1.3fr] lg:items-start">
        {/* call grid */}
        <div className="flex flex-col gap-2 ao-reveal ao-reveal-1">
          <div className="ao-section-label">Calls</div>
          {calls.map((cc, i) => {
            const st = stageOf(i)
            return (
              <button key={i} onClick={() => { setSel(i); setTakeover(false) }} className={cn('flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all', sel === i ? 'border-primary ring-1 ring-primary bg-primary/5' : 'border-border hover:bg-accent')}>
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold text-white" style={{ background: cc.avatar }}>{initials(cc.personaName)}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">{cc.personaName}</div>
                  <div className="text-xs text-muted-foreground">{cc.personaType.replace('_', ' ')}</div>
                  {st === 'live' && <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progOf(i)}%` }} /></div>}
                </div>
                {st === 'dialing' && <span className="ao-badge is-warning ao-badge--dot is-pulse">dialing</span>}
                {st === 'live' && <span className="ao-badge is-success ao-badge--dot is-pulse">live</span>}
                {st === 'done' && <span className={cn('ao-badge', cc.verdict === 'pass' ? 'is-success' : 'is-danger')}>{cc.verdict === 'pass' ? 'Pass' : 'Fail'}</span>}
              </button>
            )
          })}
          {suiteDone && (
            <div className="mt-3 flex flex-col gap-2">
              <button className="ao-btn ao-btn--outline" disabled={!batch?.evalRunId} onClick={() => batch?.evalRunId && navigate(`/evals/${batch.evalRunId}`)}><GitPullRequest size={15} /> Open suite as eval</button>
              {c?.sessionId && <button className="ao-btn ao-btn--outline" onClick={() => navigate(`/sessions/${c.sessionId}`)}><Activity size={15} /> Open Monitor session (metrics)</button>}
              <button className="ao-btn ao-btn--primary" onClick={() => { clearLiveRun(); setBatch(null); setPhase('setup') }}><RotateCw size={15} /> New suite</button>
            </div>
          )}
        </div>

        {/* selected call detail */}
        {c && (
          <div className="flex flex-col gap-4 ao-reveal ao-reveal-2">
            <section className="ao-panel">
              <div className="ao-panel-head">
                <div className="flex items-center gap-2.5">
                  <div className="flex size-7 items-center justify-center rounded-md text-[11px] font-semibold text-white" style={{ background: c.avatar }}>{initials(c.personaName)}</div>
                  <div>
                    <div className="ao-panel-title">{c.personaName}</div>
                    <div className="ao-panel-sub">{selStage === 'done' ? 'completed' : selStage === 'live' ? 'live transcript' : 'connecting…'}</div>
                  </div>
                </div>
                {directorOn && selStage === 'live' ? <span className="ao-badge is-danger ao-badge--dot is-pulse">director on stage</span>
                  : selStage === 'done' ? <span className={cn('ao-badge', c.verdict === 'pass' ? 'is-success' : 'is-danger')}>{c.verdict === 'pass' ? 'Pass' : 'Fail'}</span>
                  : <span className="ao-badge is-success ao-badge--dot is-pulse">live</span>}
              </div>
              {selStage === 'done' && (
                <div className="ao-metricstrip" style={{ margin: '14px 16px 2px' }}>
                  <div className="ao-metric-cell"><span className="k">Duration</span><span className="v">{fmtClock(c.durationS || c.cost.call_seconds)}</span></div>
                  <div className="ao-metric-cell"><span className="k">Cost</span><span className="v">{c.cost.cents}¢</span></div>
                  <div className="ao-metric-cell"><span className="k">Tokens</span><span className="v">{(c.cost.llm_tokens || 0).toLocaleString()}</span></div>
                  <div className="ao-metric-cell"><span className="k">Verdict</span><span className={cn('v', c.verdict === 'pass' ? 'is-pass' : 'is-fail')}>{c.verdict}</span></div>
                </div>
              )}
              <div ref={scrollRef} className="flex max-h-[46vh] flex-col gap-3 overflow-auto p-4">
                {selStage === 'dialing' && <div className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader size={14} className="animate-spin" /> dialing…</div>}
                {liveTurns.map((t, i) => {
                  const isUser = t.role === 'user'
                  return (
                    <div key={i} className={cn('flex gap-2.5', isUser ? 'flex-row-reverse' : '')}>
                      <div className={cn('flex size-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold', isUser ? 'bg-muted text-muted-foreground' : 'bg-primary/12 text-primary')}>{isUser ? 'C' : 'AI'}</div>
                      <div className={cn('min-w-0 flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
                        <div className={cn('max-w-[42ch] rounded-xl px-3 py-2 text-sm', isUser ? 'bg-muted' : 'bg-primary/8', t.flag === 'director' ? 'ring-1 ring-destructive/50' : t.flag ? 'ring-1 ring-destructive/40' : '')}>{t.t}</div>
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          {!isUser && t.ms != null && <span className={cn('inline-flex items-center gap-1', t.ms > 800 ? 'text-destructive' : '')}><Timer size={11} />{t.ms}ms</span>}
                          {t.flag === 'director' && <span className="inline-flex items-center gap-1 text-destructive"><Hand size={11} /> director</span>}
                          {t.flag && t.flag !== 'director' && <span className="inline-flex items-center gap-1 text-destructive"><AlertTriangle size={11} /> {t.flag}</span>}
                        </div>
                      </div>
                    </div>
                  )
                })}
                {selStage === 'live' && !directorOn && <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader size={13} className="animate-spin" /> {lastRole === 'user' ? 'agent responding…' : 'caller speaking…'}</div>}
              </div>
            </section>

            {selStage !== 'done' ? (
              isTruman ? (
                <section className="ao-panel">
                  <div className="ao-panel-head">
                    <div className="ao-panel-title"><Volume2 /> Audio legs</div>
                  </div>
                  <div className="ao-panel-body flex flex-col gap-2">
                    <AudioLeg label="Persona" color="#6366f1" speaking={personaSpeaking} muted={live.legs.persona.muted || live.takeoverActive} onMute={() => live.toggleMute('persona')} />
                    <AudioLeg label="Agent" color="hsl(var(--primary))" speaking={agentSpeaking} muted={live.legs.callee.muted} onMute={() => live.toggleMute('callee')} />
                    {live.audioBlocked && <button className="ao-btn ao-btn--outline mt-1" onClick={live.resumeAudio}><Volume2 size={15} /> Tap to enable audio</button>}
                    {live.micActive ? (
                      <div className="flex flex-col gap-2 pt-1">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-destructive"><Mic size={13} /> You're on the line — persona muted. Speak into your mic.</div>
                        <button className="ao-btn ao-btn--outline" onClick={() => void live.stopMic()}>Hand back to persona</button>
                      </div>
                    ) : (
                      <button className="ao-btn ao-btn--outline mt-1" onClick={() => void live.startMic()} disabled={selStage !== 'live'}><Hand size={15} /> Take mic on this call</button>
                    )}
                    <button className="ao-btn ao-btn--danger" onClick={() => void live.endCallNow()} disabled={live.ending}><Phone size={15} /> {live.ending ? 'Ending call…' : 'End call'}</button>
                    {live.error && <div className="text-[11px] text-destructive">{live.error}</div>}
                  </div>
                </section>
              ) : (
                <section className="ao-panel">
                  <div className="ao-panel-head">
                    <div className="ao-panel-title"><Volume2 /> Audio legs</div>
                  </div>
                  <div className="ao-panel-body flex flex-col gap-2">
                    <AudioLeg label="Persona" color="#6366f1" speaking={personaSpeaking} muted={mutePersona || takeover} onMute={() => setMutePersona((m) => !m)} />
                    <AudioLeg label="Agent" color="hsl(var(--primary))" speaking={agentSpeaking} muted={muteAgent} onMute={() => setMuteAgent((m) => !m)} />
                    {takeover ? (
                      <div className="flex flex-col gap-2 pt-1">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-destructive"><Mic size={13} /> You're on the line — persona muted.</div>
                        <div className="flex gap-2"><input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendTakeover()} placeholder="Speak as the caller…" className="ao-input flex-1" /><button className="ao-btn ao-btn--primary" onClick={sendTakeover}><Send size={15} /></button></div>
                        <button className="ao-btn ao-btn--outline" onClick={() => setTakeover(false)}>Hand back to persona</button>
                      </div>
                    ) : (
                      <button className="ao-btn ao-btn--outline mt-1" onClick={() => setTakeover(true)} disabled={selStage !== 'live'}><Hand size={15} /> Take mic on this call</button>
                    )}
                  </div>
                </section>
              )
            ) : (
              <>
                <section className="ao-panel">
                  <div className="ao-panel-head">
                    <div className="ao-panel-title"><ListChecks /> Criteria</div>
                  </div>
                  <div className="flex flex-col p-2">
                    {c.judge.criteria.map((cr) => (
                      <div key={cr.name} className="flex items-start gap-2.5 px-2 py-2">
                        <span className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full', cr.pass ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive')}>{cr.pass ? <Check size={13} /> : <X size={13} />}</span>
                        <div><div className="text-sm font-medium text-foreground">{cr.name}</div><div className="text-xs text-muted-foreground">{cr.justification}</div></div>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="ao-panel">
                  <div className="ao-panel-head">
                    <div className="ao-panel-title"><Activity /> Cost</div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 p-4 text-sm">
                    {[['LLM tokens', c.cost.llm_tokens.toLocaleString()], ['TTS chars', c.cost.tts_chars.toLocaleString()], ['STT secs', `${c.cost.stt_seconds}`], ['Call secs', `${c.cost.call_seconds}`]].map(([k, v]) => <div key={k} className="flex items-center justify-between"><span className="text-muted-foreground">{k}</span><span className="font-mono text-xs">{v}</span></div>)}
                    <div className="col-span-2 mt-1 flex items-center justify-between border-t border-border pt-2"><span className="text-muted-foreground">Total</span><span className="font-semibold">{c.cost.cents}¢</span></div>
                  </div>
                </section>
                {c.recordingUrl && (
                  <section className="ao-panel">
                    <div className="ao-panel-head">
                      <div className="ao-panel-title"><FileCode /> Recording</div>
                    </div>
                    <div className="ao-panel-body"><AudioPlayer src={c.recordingUrl} durationHint={c.cost?.call_seconds} /></div>
                  </section>
                )}
                {c.error && (
                  <div className="ao-alert is-danger">
                    <AlertTriangle /><span>{c.error}</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
