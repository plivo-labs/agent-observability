import { useMemo, useState } from 'react'
import { ChevronRight, GitBranch } from 'lucide-react'
import { useEvalRuns, useEvalAgents } from '@/lib/observability-hooks'
import type { EvalRunRow } from '@/lib/observability-types'

function PassBar({ passed, total }: { passed: number; total: number }) {
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0
  const tone = pct >= 70 ? 'good' : pct >= 50 ? 'warn' : 'bad'
  return (
    <div className="eval-passrate">
      <span className={`eval-passrate__value eval-passrate__value--${tone}`}>{pct}%</span>
      <span className="eval-passrate__track">
        <span className={`eval-passrate__bar eval-passrate__bar--${tone}`} style={{ width: `${pct}%` }} />
      </span>
    </div>
  )
}

function fmtTimeShort(iso: string): string {
  const d = new Date(iso)
  let h = d.getHours()
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12; if (h === 0) h = 12
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${mm} ${ampm}`
}

function fmtDur(ms: number | null): string {
  if (ms == null) return '—'
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${s}s`
}

function dayLabel(iso: string): string {
  const now = new Date()
  const d = new Date(iso)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diff = Math.round((todayStart.getTime() - dayStart.getTime()) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return `${diff} days ago`
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${m[d.getMonth()]} ${d.getDate()}`
}

type FilterKind = 'all' | 'passed' | 'failed' | 'regressed'

interface FeedItem {
  run: EvalRunRow
  agentId: string
  delta: number | null
}

export function ActivityPage({
  onOpenRun,
  onOpenAgent,
}: {
  onOpenRun?: (agentId: string, runId: string) => void
  onOpenAgent?: (agentId: string) => void
}) {
  const { agents } = useEvalAgents()
  // Fetch a large batch of recent runs across all agents
  const { runs, loading } = useEvalRuns(100, 0)
  const [filter, setFilter] = useState<FilterKind>('all')

  // Build feed items with per-agent delta vs previous run
  const items = useMemo<FeedItem[]>(() => {
    // Group by agent_id, sorted desc within each agent
    const byAgent: Record<string, EvalRunRow[]> = {}
    for (const r of runs) {
      const key = r.agent_id ?? '__unknown__'
      ;(byAgent[key] = byAgent[key] ?? []).push(r)
    }
    // Sort each agent's runs desc
    for (const key of Object.keys(byAgent)) {
      byAgent[key].sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
    }
    // Build flat list with delta
    const out: FeedItem[] = []
    for (const [agentId, agentRuns] of Object.entries(byAgent)) {
      for (let i = 0; i < agentRuns.length; i++) {
        const run = agentRuns[i]
        const prev = agentRuns[i + 1]
        const passRate = run.total > 0 ? run.passed / run.total : null
        const prevRate = prev && prev.total > 0 ? prev.passed / prev.total : null
        const delta = passRate != null && prevRate != null ? (passRate - prevRate) * 100 : null
        out.push({ run, agentId, delta })
      }
    }
    // Sort all by started_at desc
    out.sort((a, b) => new Date(b.run.started_at).getTime() - new Date(a.run.started_at).getTime())
    return out.slice(0, 80)
  }, [runs])

  const filtered = useMemo(() => {
    return items.filter(it => {
      if (it.run.total === 0) return filter === 'all'
      const pr = it.run.passed / it.run.total
      if (filter === 'passed') return pr >= 0.7
      if (filter === 'failed') return pr < 0.5
      if (filter === 'regressed') return it.delta != null && it.delta < -5
      return true
    })
  }, [items, filter])

  // Group by day
  const groups = useMemo(() => {
    const g: Record<string, FeedItem[]> = {}
    for (const it of filtered) {
      const k = dayLabel(it.run.started_at)
      ;(g[k] = g[k] ?? []).push(it)
    }
    return g
  }, [filtered])

  const last24h = items.filter(it => Date.now() - new Date(it.run.started_at).getTime() < 86_400_000)
  const last24Pass = last24h.filter(it => it.run.total > 0 && it.run.passed / it.run.total >= 0.7).length
  const last24Fail = last24h.filter(it => it.run.total > 0 && it.run.passed / it.run.total < 0.5).length
  const last24Regress = last24h.filter(it => it.delta != null && it.delta < -5).length

  return (
    <div className="w-full p-6 flex flex-col gap-0 min-w-0">
      <div className="flex items-center justify-between" style={{ marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }}>
            Activity
          </h1>
          <div style={{ color: 'hsl(var(--muted-foreground))', fontSize: 13, marginTop: 4 }}>
            Live feed of eval runs across all agents
          </div>
        </div>
      </div>

      <div className="eval-kpi-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
        <div className="eval-kpi">
          <div className="eval-kpi__label">Runs (24h)</div>
          <div className="eval-kpi__value">{last24h.length}</div>
          <div className="eval-kpi__delta">{agents.length} agents active</div>
        </div>
        <div className="eval-kpi">
          <div className="eval-kpi__label">Passing</div>
          <div className="eval-kpi__value" style={{ color: 'hsl(142 70% 28%)' }}>{last24Pass}</div>
          <div className="eval-kpi__delta eval-kpi__delta--up">
            {last24h.length ? `${Math.round(last24Pass / last24h.length * 100)}%` : '—'} of recent
          </div>
        </div>
        <div className="eval-kpi">
          <div className="eval-kpi__label">Failing</div>
          <div className="eval-kpi__value" style={{ color: 'hsl(var(--destructive))' }}>{last24Fail}</div>
          <div className="eval-kpi__delta eval-kpi__delta--down">
            {last24h.length ? `${Math.round(last24Fail / last24h.length * 100)}%` : '—'} of recent
          </div>
        </div>
        <div className="eval-kpi">
          <div className="eval-kpi__label">Regressed</div>
          <div className="eval-kpi__value" style={{ color: last24Regress > 0 ? 'hsl(38 80% 40%)' : 'hsl(var(--foreground))' }}>{last24Regress}</div>
          <div className="eval-kpi__delta">vs previous run on agent</div>
        </div>
      </div>

      <div className="eval-toolbar">
        <div className="eval-seg">
          {([['all', 'All'], ['passed', 'Passing'], ['failed', 'Failing'], ['regressed', 'Regressed']] as [FilterKind, string][]).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={filter === k ? "true" : "false"} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'hsl(var(--muted-foreground))' }}>
          {filtered.length} of {items.length} runs
        </span>
      </div>

      {loading && (
        <div style={{ padding: '24px', textAlign: 'center', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          Loading activity…
        </div>
      )}

      {!loading && (
        <div className="eval-activity">
          {Object.entries(groups).map(([day, list]) => (
            <div key={day}>
              <div className="eval-activity-day">{day}</div>
              {list.map(({ run, agentId, delta }) => {
                const empty = run.total === 0
                const pr = empty ? null : run.passed / run.total
                const pass = pr != null && pr >= 0.7
                const fail = pr != null && pr < 0.5
                const cls = pass ? 'pass' : fail ? 'fail' : empty ? '' : 'warn'
                return (
                  <div
                    key={run.run_id}
                    className={`eval-activity-row ${cls}`}
                    onClick={() => onOpenRun?.(agentId, run.run_id)}
                  >
                    {/* Time */}
                    <div>
                      <div className="when">{fmtTimeShort(run.started_at)}</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'hsl(var(--muted-foreground))' }}>
                        {fmtDur(run.duration_ms)}
                      </div>
                    </div>
                    {/* Agent + branch */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <span className="verdict-bar" />
                      <div style={{ minWidth: 0 }}>
                        <div
                          className="agent-name"
                          onClick={e => { e.stopPropagation(); onOpenAgent?.(agentId) }}
                        >
                          {agentId === '__unknown__' ? <em>unknown</em> : agentId}
                        </div>
                        <div className="meta">
                          <GitBranch size={11} />
                          {run.ci?.git_branch ?? 'main'}
                          {run.ci?.git_sha && (
                            <span style={{ fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}>
                              · {String(run.ci.git_sha).slice(0, 7)}
                            </span>
                          )}
                          <span>·</span>
                          <span>{empty ? 'no cases' : `${run.passed}/${run.total} cases`}</span>
                        </div>
                      </div>
                    </div>
                    {/* Pass rate */}
                    <div>{empty ? <span style={{ fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}>—</span> : <PassBar passed={run.passed} total={run.total} />}</div>
                    {/* p95 TTFT */}
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      {run.ttft_p95_ms != null
                        ? <span style={{ color: run.ttft_p95_ms > 10000 ? 'hsl(var(--destructive))' : 'hsl(var(--foreground))' }}>
                            {run.ttft_p95_ms >= 1000 ? `${(run.ttft_p95_ms / 1000).toFixed(2)}s` : `${run.ttft_p95_ms}ms`}
                          </span>
                        : <span style={{ color: 'hsl(var(--muted-foreground))' }}>—</span>}
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>p95 TTFT</div>
                    </div>
                    {/* Cost */}
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      {run.estimated_cost_usd != null ? `$${run.estimated_cost_usd.toFixed(3)}` : '—'}
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>cost</div>
                    </div>
                    {/* Delta */}
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                      {delta != null
                        ? <span style={{ color: delta > 0 ? 'hsl(142 70% 28%)' : delta < 0 ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))' }}>
                            {delta > 0 ? '▲' : delta < 0 ? '▼' : '–'} {Math.abs(delta).toFixed(0)}pp
                          </span>
                        : <span style={{ color: 'hsl(var(--muted-foreground))' }}>—</span>}
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>vs prev</div>
                    </div>
                    <div style={{ color: 'hsl(var(--muted-foreground))' }}><ChevronRight size={14} /></div>
                  </div>
                )
              })}
            </div>
          ))}
          {filtered.length === 0 && !loading && (
            <div style={{ padding: '40px', textAlign: 'center', color: 'hsl(var(--muted-foreground))' }}>
              No runs found.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
