import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, GitBranch, Play, Scale, Trash2 } from 'lucide-react'
import { Link } from 'react-router'
import { Checkbox } from '@/components/ui/checkbox'
import { useEvalRuns } from '@/lib/observability-hooks'
import { formatDate, formatDuration, formatMs, formatTokens, formatCost } from '@/lib/observability-format'
import { useObservabilityContext } from '@/lib/observability-provider'
import type { CiMetadata } from '@/lib/observability-types'

function getCommitLink(ci: CiMetadata | null, sha: string | undefined): string | null {
  if (!ci || !sha) return null

  const explicit = typeof ci.git_commit_url === 'string' ? ci.git_commit_url : null
  if (explicit) return explicit

  const runUrl = typeof ci.run_url === 'string' ? ci.run_url : null
  if (!runUrl) return null

  const provider = typeof ci.provider === 'string' ? ci.provider.toLowerCase() : ''
  if (provider === 'github') {
    const marker = '/actions/runs/'
    const idx = runUrl.indexOf(marker)
    if (idx > 0) return `${runUrl.slice(0, idx)}/commit/${sha}`
  }
  if (provider === 'gitlab') {
    const marker = '/-/jobs/'
    const idx = runUrl.indexOf(marker)
    if (idx > 0) return `${runUrl.slice(0, idx)}/-/commit/${sha}`
  }
  return null
}

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

function KpiTile({ label, value, unit, sub }: { label: string; value: string; unit?: string; sub?: string }) {
  return (
    <div className="eval-kpi">
      <div className="eval-kpi__label">{label}</div>
      <div className="eval-kpi__value">
        {value}{unit && <span className="unit">{unit}</span>}
      </div>
      {sub && <div className="eval-kpi__delta">{sub}</div>}
    </div>
  )
}

export function AgentRunsPage({
  agentId,
  onBack: _onBack,
  onRunClick,
  onCompare,
}: {
  agentId: string
  onBack?: () => void
  onRunClick?: (runId: string) => void
  onCompare?: (runIdA: string, runIdB: string) => void
}) {
  const { runs, loading, error, refetch } = useEvalRuns(50, 0, { agentId })
  const { api } = useObservabilityContext()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [runSearch, setRunSearch] = useState('')
  const [deleting, setDeleting] = useState(false)

  const validRuns = useMemo(() => runs.filter(r => r.total > 0), [runs])
  const filteredRuns = useMemo(() => {
    const q = runSearch.trim().toLowerCase()
    if (!q) return runs
    return runs.filter((r) => {
      const name = (r.name ?? '').toLowerCase()
      return name.includes(q) || r.run_id.toLowerCase().includes(q)
    })
  }, [runs, runSearch])

  const stats = useMemo(() => {
    const avgPass = validRuns.length
      ? validRuns.reduce((s, r) => s + (r.total > 0 ? r.passed / r.total : 0), 0) / validRuns.length
      : 0
    const p95Values = validRuns.map(r => r.ttft_p95_ms).filter((v): v is number => v != null)
    const avgP95 = p95Values.length
      ? p95Values.reduce((s, v) => s + v, 0) / p95Values.length
      : null
    const totalCost = runs.reduce((s, r) => s + (r.estimated_cost_usd ?? 0), 0)
    return { avgPass, avgP95, totalCost }
  }, [runs, validRuns])

  const toggleSel = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const selArray = [...selected]
  const canCompare = selected.size === 2
  const hasRunningRun = runs.some((run) => run.status === 'running')

  const handleDeleteSelected = async () => {
    if (selected.size === 0 || deleting) return
    const ok = window.confirm(`Delete ${selected.size} selected run${selected.size === 1 ? '' : 's'}? This cannot be undone.`)
    if (!ok) return
    setDeleting(true)
    try {
      await api.deleteEvalRuns([...selected])
      setSelected(new Set())
      refetch()
    } finally {
      setDeleting(false)
    }
  }

  useEffect(() => {
    if (!hasRunningRun) return
    const id = window.setInterval(() => refetch(), 1500)
    return () => window.clearInterval(id)
  }, [hasRunningRun, refetch])

  return (
    <div className="w-full p-6 flex flex-col gap-0 min-w-0">
      <div className="eval-breadcrumbs">
        <Link to="/evals">Evals</Link>
        <span className="eval-breadcrumbs__sep">/</span>
        <span className="eval-breadcrumbs__current">{agentId}</span>
      </div>

      <div className="flex items-start justify-between" style={{ marginTop: 4, marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 600 }}>{agentId}</h1>
          <div style={{ color: 'hsl(var(--muted-foreground))', fontSize: 13, marginTop: 4, display: 'flex', gap: 10, alignItems: 'center' }}>
            <span>{runs.length} runs</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {canCompare && (
            <button
              type="button"
              className="eval-action-btn eval-action-btn--accent"
              onClick={() => onCompare?.(selArray[0], selArray[1])}
            >
              <Scale size={14} /> Compare 2 runs
            </button>
          )}
          {validRuns.length >= 2 && selected.size === 0 && (
            <button
              type="button"
              className="eval-action-btn"
              onClick={() => onCompare?.(validRuns[1].run_id, validRuns[0].run_id)}
            >
              <Scale size={14} /> Compare last 2
            </button>
          )}
          <button type="button" className="eval-action-btn eval-action-btn--primary">
            <Play size={14} /> New run
          </button>
        </div>
      </div>

      <div className="eval-kpi-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
        <KpiTile label="Pass rate (avg)" value={`${(stats.avgPass * 100).toFixed(1)}`} unit="%" />
        <KpiTile label="p95 TTFT" value={stats.avgP95 != null ? formatMs(stats.avgP95) : '—'} />
        <KpiTile label="Total cost" value={formatCost(stats.totalCost)} />
        <KpiTile label="Total runs" value={String(runs.length)} />
      </div>

      {error && (
        <div role="alert" className="border border-border bg-muted px-4 py-2.5 rounded-lg text-s-400" style={{ marginBottom: 12 }}>
          Failed to load runs: {error}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        {selected.size > 0 && (
          <button
            type="button"
            className="eval-action-btn"
            onClick={handleDeleteSelected}
            disabled={deleting}
          >
            <Trash2 size={14} /> {deleting ? 'Deleting...' : 'Delete'}
          </button>
        )}
        <input
          type="text"
          placeholder="Search name or run id..."
          value={runSearch}
          onChange={(e) => setRunSearch(e.target.value)}
          className="h-8 w-64 rounded-md border border-border bg-background px-3 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <div style={{ borderRadius: 10, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 12.5 }}>
          <thead>
            <tr>
              {['', 'Started', 'Name', 'Pass rate', 'Cases', 'Duration', 'p95 TTFT', 'p95 TTFB', 'Tokens', 'Cache', 'Cost', 'Commit', ''].map((h, i) => (
                <th key={i} style={{
                  padding: '10px 14px', textAlign: 'left', fontWeight: 500,
                  color: 'hsl(var(--muted-foreground))', fontSize: 11,
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                  borderBottom: '1px solid hsl(var(--border))',
                  background: 'hsl(var(--card))', whiteSpace: 'nowrap',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={13} style={{ padding: '24px 14px', textAlign: 'center', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                  Loading runs…
                </td>
              </tr>
            )}
            {!loading && filteredRuns.map(r => {
              const isEmpty = r.total === 0
              const isSel = selected.has(r.run_id)
              const sha = r.ci?.git_sha ? String(r.ci.git_sha) : null
              const commitUrl = getCommitLink(r.ci, sha ?? undefined)
              return (
                <tr
                  key={r.run_id}
                  onClick={() => onRunClick?.(r.run_id)}
                  style={{
                    cursor: 'pointer',
                    background: isSel ? 'hsl(270 60% 55% / 0.08)' : '',
                    transition: 'background 100ms ease',
                  }}
                  onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'hsl(var(--muted))' }}
                  onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = '' }}
                >
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', width: 32 }} onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={isSel}
                        onCheckedChange={(checked) => {
                          const shouldSelect = checked === true
                          if (shouldSelect !== isSel) toggleSel(r.run_id)
                        }}
                        aria-label={`Select run ${r.run_id}`}
                      />
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      {r.status === 'running' && <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />}
                      {formatDate(r.started_at)}
                    </span>
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontSize: 12.5, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.name
                      ? <span title={r.name}>{r.name}</span>
                      : <span style={{ color: 'hsl(var(--muted-foreground))' }}>—</span>}
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))' }}>
                    {isEmpty
                      ? <span style={{ fontFamily: 'var(--font-mono)', color: 'hsl(var(--muted-foreground))' }}>—</span>
                      : <PassBar passed={r.passed} total={r.total} />}
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    {isEmpty ? <span style={{ color: 'hsl(var(--muted-foreground))' }}>0</span> : r.total}
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                    {formatDuration(r.duration_ms)}
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    {r.ttft_p95_ms != null
                      ? <span style={{ color: r.ttft_p95_ms > 10000 ? 'hsl(var(--destructive))' : 'hsl(var(--foreground))' }}>{formatMs(r.ttft_p95_ms)}</span>
                      : <span style={{ color: 'hsl(var(--muted-foreground))' }}>—</span>}
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                    {r.ttfb_p95_ms != null ? formatMs(r.ttfb_p95_ms) : '—'}
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                    {formatTokens(r.total_tokens)}
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--muted-foreground))' }}>
                    {r.prompt_tokens > 0 ? Math.round((r.cached_prompt_tokens / r.prompt_tokens) * 100) + '%' : '—'}
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                    {formatCost(r.estimated_cost_usd)}
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
                    {!sha && <span style={{ color: 'hsl(var(--muted-foreground))' }}>—</span>}
                    {sha && commitUrl && (
                      <a
                        href={commitUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        style={{ color: 'hsl(var(--foreground))', textDecoration: 'none' }}
                        title={r.ci?.git_branch ? `${sha}\nbranch: ${String(r.ci.git_branch)}` : sha}
                      >
                        {sha.slice(0, 7)}
                      </a>
                    )}
                    {sha && !commitUrl && (
                      <span
                        title={r.ci?.git_branch ? `${sha}\nbranch: ${String(r.ci.git_branch)}` : sha}
                        style={{ color: 'hsl(var(--muted-foreground))', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      >
                        {sha.slice(0, 7)}
                        <span style={{
                          fontSize: 10,
                          lineHeight: 1,
                          padding: '2px 5px',
                          borderRadius: 999,
                          border: '1px solid hsl(var(--border))',
                          color: 'hsl(var(--muted-foreground))',
                        }}>
                          local
                        </span>
                      </span>
                    )}
                    {!sha && r.ci?.git_branch && (
                      <span style={{ color: 'hsl(var(--muted-foreground))', display: 'inline-flex', alignItems: 'center', gap: 4 }} title={`branch: ${String(r.ci.git_branch)}`}>
                        <GitBranch size={12} />
                        <span style={{ fontSize: 11 }}>{String(r.ci.git_branch)}</span>
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', width: 24, color: 'hsl(var(--muted-foreground))' }}>
                    <ChevronRight size={14} />
                  </td>
                </tr>
              )
            })}
            {!loading && filteredRuns.length === 0 && (
              <tr>
                <td colSpan={13} style={{ padding: '24px 14px', textAlign: 'center', color: 'hsl(var(--muted-foreground))' }}>
                  No runs match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
