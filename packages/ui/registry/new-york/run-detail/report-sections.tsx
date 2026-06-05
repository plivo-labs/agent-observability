/* report-sections.tsx — shared run-detail report widgets for a persisted
 * simulation report (`sim_report` on an eval run). Replicates the Simulate
 * report's score-ring / axis-bar / worst-moments / fixes / leveled-judge look
 * so a text-sim eval run shows the same rich report after it's saved.
 *
 * Self-contained + on-theme (Neo tokens only). Types mirror the backend
 * `sim_report` block; kept local so this file is reusable without coupling to
 * the Simulate module (which another agent owns). */
import { useState } from 'react'
import { AlertOctagon, Check, ChevronRight, CopyIcon, CornerDownRight, Scale, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ---------- types (mirror backend sim_report) ---------- */
export type SimReportSeverity = 'critical' | 'high' | 'medium'

export interface SimReportJudgeNode {
  scope: string
  status: 'pass' | 'fail'
  verdict: string
  turn?: number
}
export interface SimReportJudgeTask {
  id: string
  name: string
  score: number
  status: 'pass' | 'fail'
  verdict: string
  turn?: number
  nodes?: SimReportJudgeNode[]
}
export interface SimReportJudgeAgent {
  id: string
  name: string
  score: number
  status: 'pass' | 'fail'
  verdict: string
  tasks: SimReportJudgeTask[]
}
export interface SimReportJudgeTree {
  caseLabel: string
  flow: { score: number; max: number; status: 'pass' | 'fail'; verdict: string }
  agents: SimReportJudgeAgent[]
  nodes: SimReportJudgeNode[]
}

export interface SimReport {
  overallScore: number
  passRate: number // 0..1
  threshold: number
  rubricAxes: { name: string; score: number; weight: number }[]
  worstMoments: { case: string; scope: string; text: string; sev: SimReportSeverity }[]
  fixes: { title: string; body: string }[]
  judgeTree: SimReportJudgeTree
  /** Per-case leveled-judge trees keyed by persona/case name (== EvalCaseRow.name).
   *  Lets the run-detail page render the SELECTED persona's tree. Absent on older
   *  persisted runs → caller falls back to `judgeTree`. */
  caseTrees?: Record<string, SimReportJudgeTree>
  engine: string
  personaCount: number
}

/* ---------- score helpers ---------- */
const scoreText = (s: number) => (s >= 80 ? 'text-success' : s >= 65 ? 'text-warning' : 'text-destructive')
const scoreStroke = (s: number) => (s >= 80 ? 'hsl(var(--success))' : s >= 65 ? 'hsl(var(--warning))' : 'hsl(var(--destructive))')
const scoreBar = (s: number) => (s >= 80 ? 'bg-success' : s >= 65 ? 'bg-warning' : 'bg-destructive')

/* ---------- primitives ---------- */
export function SectionTitle({ icon, title, hint }: { icon?: React.ReactNode; title: React.ReactNode; hint: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        {icon}
        {title}
      </div>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </div>
  )
}

export function ScoreRing({ score, max = 100, size = 88, stroke = 8, showMax }: { score: number; max?: number; size?: number; stroke?: number; showMax?: boolean }) {
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

export function ScopeTag({ scope }: { scope: string }) {
  const level = scope.split(':')[0]
  const colors: Record<string, string> = {
    flow: 'bg-chart-2/12 text-[hsl(270_82%_51%)]',
    agent: 'bg-chart-1/12 text-[hsl(225_100%_45%)]',
    task: 'bg-chart-4/12 text-[hsl(38_96%_40%)]',
    node: 'bg-chart-3/12 text-[hsl(149_89%_32%)]',
  }
  return <span className={cn('rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium', colors[level] ?? 'bg-muted text-muted-foreground')}>{scope}</span>
}

function StatusPill({ status }: { status: 'pass' | 'fail' }) {
  return (
    <span className={cn('ao-badge whitespace-nowrap', status === 'pass' ? 'is-success' : 'is-danger')}>
      {status === 'pass' ? 'Pass' : 'Fail'}
    </span>
  )
}

function severityPill(sev: SimReportSeverity) {
  const map = { critical: 'is-danger', high: 'is-warning', medium: 'is-accent' } as const
  const label = { critical: 'Critical', high: 'High', medium: 'Medium' } as const
  return <span className={cn('ao-badge whitespace-nowrap', map[sev])}>{label[sev]}</span>
}

/* ---------- (a) Scorer ---------- */
export function ScorerBox({ report }: { report: SimReport }) {
  const passPct = Math.round(report.passRate * 100)
  const passN = Math.round(report.passRate * report.personaCount)
  const failN = report.personaCount - passN
  const verdict: 'pass' | 'fail' = report.passRate >= 0.7 ? 'pass' : 'fail'
  return (
    <div className="ao-panel">
      <div className="ao-panel-head">
        <SectionTitle icon={<Scale size={16} className="shrink-0 text-[hsl(var(--link))]" />} title="Scorer" hint="overall pass score vs threshold" />
        <StatusPill status={verdict} />
      </div>
      <div className="flex items-center gap-4 p-5">
        <ScoreRing score={report.overallScore} size={88} stroke={8} showMax />
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status="pass" /><span className="text-sm text-muted-foreground">{passN} passed</span>
            <StatusPill status="fail" /><span className="text-sm text-muted-foreground">{failN} failed</span>
          </div>
          <div className="text-sm text-muted-foreground">Pass rate <b className="text-foreground tabular-nums">{passPct}%</b> across {report.personaCount} {report.personaCount === 1 ? 'persona' : 'personas'}</div>
          <div className="text-sm text-muted-foreground">Pass threshold <b className="text-foreground tabular-nums">{report.threshold}</b></div>
        </div>
      </div>
    </div>
  )
}

/* ---------- (b) Rubric ---------- */
export function RubricBox({ report, rubricName }: { report: SimReport; rubricName?: string | null }) {
  return (
    <div className="ao-panel">
      <div className="ao-panel-head">
        <SectionTitle title={<>Rubric · {rubricName ?? '7-axis'}</>} hint="per-axis quality breakdown" />
        <span className="ao-panel-sub">{report.rubricAxes.length} axes</span>
      </div>
      <div className="p-5">
        {report.rubricAxes.length === 0 ? (
          <div className="text-sm text-muted-foreground">No rubric axes recorded.</div>
        ) : report.rubricAxes.map((a) => (
          <div key={a.name} className="flex items-center gap-3 py-0.5">
            <span className="w-36 shrink-0 truncate text-sm text-foreground" title={a.name}>{a.name}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full', scoreBar(a.score))} style={{ width: `${a.score}%` }} /></div>
            <span className={cn('w-7 text-right text-sm font-semibold tabular-nums', scoreText(a.score))}>{a.score}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------- (c) Leveled judge ---------- */
function JudgeRow({ children, indent = 0, onClick }: { children: React.ReactNode; indent?: number; onClick?: () => void }) {
  // When the row is interactive, expose it as a keyboard-operable button so the
  // expand toggle isn't mouse-only (a11y).
  const interactive = !!onClick
  const onKeyDown = interactive
    ? (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!() }
      }
    : undefined
  return (
    <div
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={onKeyDown}
      className={cn('flex items-center gap-2.5 border-b border-border/60 px-4 py-2.5 text-sm', interactive ? 'cursor-pointer hover:bg-muted/40' : '')}
      style={{ paddingLeft: 16 + indent }}
    >
      {children}
    </div>
  )
}

/** Shared leveled-judge panel. Optional props let the Simulate report reuse it:
 *  - `caseLabel` overrides the per-persona heading (Simulate passes the selected
 *    persona's display name; Evals run-detail uses `tree.caseLabel`).
 *  - `onJump(turn)` adds a "Jump to turn N" link under each turn-anchored node
 *    row (Simulate scrolls its live transcript; Evals omits it). */
export function LeveledJudgeBox({ tree, caseLabel, onJump }: {
  tree: SimReportJudgeTree
  caseLabel?: React.ReactNode
  onJump?: (turn: number) => void
}) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const o: Record<string, boolean> = {}
    tree.agents.forEach((a) => { if (a.status === 'fail') { o[a.id] = true; a.tasks.forEach((t) => { if (t.status === 'fail') o[t.id] = true }) } })
    return o
  })
  const tog = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }))
  return (
    <div className="ao-panel">
      <div className="ao-panel-head">
        <SectionTitle icon={<Scale size={16} className="shrink-0 text-[hsl(var(--link))]" />} title={<>Leveled judge · {caseLabel ?? tree.caseLabel}</>} hint="where the agent passed or failed — whole conversation down to a single turn" />
        <span className="ao-badge is-accent">LiveKit-native</span>
      </div>
      <div className="border-b border-border px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
        The judge grades the <b className="font-medium text-foreground">whole conversation</b> first, then breaks it down by <b className="font-medium text-foreground">agent</b>, by <b className="font-medium text-foreground">task</b>, and by each individual <b className="font-medium text-foreground">turn</b> (when available) — so you can see exactly where things went wrong. Click any row to expand it.
      </div>
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
              <StatusPill status={ag.status} />
              <span className={cn('font-semibold tabular-nums', scoreText(ag.score))}>{ag.score}</span>
            </JudgeRow>
            {open[ag.id] && ag.tasks.map((tk) => (
              <div key={tk.id}>
                <JudgeRow indent={36} onClick={tk.nodes ? () => tog(tk.id) : undefined}>
                  {tk.nodes ? <ChevronRight size={14} className={cn('shrink-0 text-muted-foreground transition-transform', open[tk.id] ? 'rotate-90' : '')} /> : <span className="w-3.5 shrink-0" />}
                  <ScopeTag scope={`task:${tk.id}`} />
                  <span className="min-w-0 flex-1 text-muted-foreground">{tk.verdict}</span>
                  <StatusPill status={tk.status} />
                  <span className={cn('font-semibold tabular-nums', scoreText(tk.score))}>{tk.score}</span>
                </JudgeRow>
                {tk.nodes && open[tk.id] && tk.nodes.map((nd, i) => (
                  <div key={i} className="flex items-start gap-2.5 border-b border-border/60 bg-muted/30 px-4 py-2.5 text-sm" style={{ paddingLeft: 64 }}>
                    <ScopeTag scope={nd.scope} />
                    <div className="min-w-0 flex-1">
                      <div className="text-muted-foreground">{nd.verdict}</div>
                      {onJump && nd.turn != null && (
                        <button onClick={() => onJump(nd.turn!)} className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                          <CornerDownRight size={12} /> Jump to turn {nd.turn + 1}
                        </button>
                      )}
                    </div>
                    <StatusPill status={nd.status} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------- (d) Worst moments + Recommended fixes ---------- */
export function WorstMomentsBox({ report }: { report: SimReport }) {
  const moments = report.worstMoments
  // No real failures (nothing critical/high) → render nothing for this section.
  const hasReal = moments.some((w) => w.sev === 'critical' || w.sev === 'high')
  if (!hasReal) return null
  return (
    <div className="ao-panel">
      <div className="ao-panel-head">
        <SectionTitle icon={<AlertOctagon size={16} className="shrink-0 text-destructive" />} title="Worst moments" hint="lowest-scoring turns" />
      </div>
      <div className="flex flex-col divide-y divide-border/60">
        {moments.map((w, i) => (
          <div key={i} className="flex flex-col gap-1.5 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2.5"><ScopeTag scope={w.scope} />{severityPill(w.sev)}<span className="text-xs text-muted-foreground">{w.case}</span></div>
            <div className="text-sm text-foreground">{w.text}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function FixesBox({ report }: { report: SimReport }) {
  const [copied, setCopied] = useState(false)
  const copyFixes = () => {
    const text = report.fixes.map((f, i) => `${i + 1}. ${f.title}\n${f.body}`).join('\n\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }
  return (
    <div className="ao-panel">
      <div className="ao-panel-head">
        <SectionTitle icon={<Wrench size={16} className="shrink-0 text-[hsl(var(--link))]" />} title="Recommended fixes" hint="suggested prompt / config changes" />
        <button className="ao-btn ao-btn--outline ao-btn--sm" onClick={copyFixes} disabled={report.fixes.length === 0}>
          {copied ? <Check size={13} /> : <CopyIcon size={13} />} {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <div className="flex flex-col divide-y divide-border/60">
        {report.fixes.length === 0 && <div className="px-4 py-3 text-sm text-muted-foreground">No fixes recommended.</div>}
        {report.fixes.map((f, i) => (
          <div key={i} className="flex gap-3 px-4 py-3">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">{i + 1}</span>
            <div><div className="text-sm font-semibold text-foreground">{f.title}</div><div className="text-sm text-muted-foreground">{f.body}</div></div>
          </div>
        ))}
      </div>
    </div>
  )
}
