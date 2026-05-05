import { useMemo, useState } from 'react'
import { Bot, ChevronRight, ChevronDown, ChevronUp, Search } from 'lucide-react'
import { useEvalAgents } from '@/lib/observability-hooks'
import { formatDate, formatMs } from '@/lib/observability-format'
import type { AgentRow } from '@/lib/observability-types'

type TrendStyle = 'dots' | 'bars' | 'spark'
type SortKey = 'agent_id' | 'last_run_at' | 'avg_pass_rate' | 'ttft_p95_ms' | 'run_count'
type SortDir = 'asc' | 'desc'

function Sparkline({ values, color = 'hsl(270 60% 55%)', width = 80, height = 26 }: {
  values: number[]; color?: string; width?: number; height?: number
}) {
  if (!values || values.length < 2) return <svg width={width} height={height} />
  const min = Math.min(...values), max = Math.max(...values)
  const range = max - min || 1
  const dx = width / (values.length - 1)
  const pts = values.map((v, i): [number, number] => [
    i * dx,
    height - 2 - ((v - min) / range) * (height - 4)
  ])
  const path = pts.map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(' ')
  const area = path + ` L${width},${height} L0,${height} Z`
  return (
    <svg width={width} height={height}>
      <path d={area} fill={color} opacity={0.12} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2" fill={color} />
    </svg>
  )
}

function TrendDots({ trend }: { trend: AgentRow['trend'] }) {
  const ordered = [...trend].reverse()
  return (
    <span className="eval-trend-dots">
      {ordered.map((t) => {
        const cls = t.pass_rate >= 70 ? 'dot--pass' : t.pass_rate >= 50 ? 'dot--warn' : 'dot--fail'
        return <span key={t.run_id} className={`dot ${cls}`} title={`${Math.round(t.pass_rate)}%`} />
      })}
    </span>
  )
}

function TrendBars({ trend }: { trend: AgentRow['trend'] }) {
  const ordered = [...trend].reverse()
  return (
    <span className="eval-trend-bars">
      {ordered.map((t, i) => {
        const cls = t.pass_rate >= 70 ? 'bar--pass' : t.pass_rate >= 50 ? 'bar--warn' : 'bar--fail'
        return (
          <span
            key={t.run_id}
            className={`bar ${cls}`}
            style={{ height: `${6 + (i % 5) * 2.5}px` }}
          />
        )
      })}
    </span>
  )
}

function TrendSpark({ trend }: { trend: AgentRow['trend'] }) {
  const vals = [...trend].reverse().map(t => t.pass_rate / 100)
  return <Sparkline values={vals.length > 1 ? vals : [0.5, 0.5]} color="hsl(270 60% 55%)" width={70} height={20} />
}

function PassRateCell({ rate, prevRate }: { rate: number; prevRate?: number }) {
  const pct = Math.round(rate)
  const tone = pct >= 70 ? 'good' : pct >= 50 ? 'warn' : 'bad'
  const delta = prevRate != null ? rate - prevRate : null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div className="eval-passrate">
        <span className={`eval-passrate__value eval-passrate__value--${tone}`}>{pct}%</span>
        <span className="eval-passrate__track">
          <span className={`eval-passrate__bar eval-passrate__bar--${tone}`} style={{ width: `${pct}%` }} />
        </span>
      </div>
      {delta != null && Math.abs(delta) > 0.5 && (
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 11,
          color: delta > 0 ? 'hsl(var(--success-fg, 142 70% 28%))' : 'hsl(var(--destructive))'
        }}>
          {delta > 0 ? '▲' : '▼'}{Math.abs(delta).toFixed(0)}
        </span>
      )}
    </div>
  )
}

function KpiTile({
  label, value, unit, delta, deltaGood, sparkValues, sparkColor, barPct, barVariant
}: {
  label: string; value: string; unit?: string; delta?: string; deltaGood?: boolean
  sparkValues?: number[]; sparkColor?: string; barPct?: number; barVariant?: string
}) {
  return (
    <div className="eval-kpi">
      <div className="eval-kpi__label">{label}</div>
      <div className="eval-kpi__value">
        {value}{unit && <span className="unit">{unit}</span>}
      </div>
      {delta && (
        <div className={`eval-kpi__delta ${deltaGood === true ? 'eval-kpi__delta--up' : deltaGood === false ? 'eval-kpi__delta--down' : ''}`}>
          {delta}
        </div>
      )}
      {sparkValues && (
        <div className="eval-kpi__spark">
          <Sparkline values={sparkValues} color={sparkColor || 'hsl(270 60% 55%)'} width={80} height={26} />
        </div>
      )}
      {barPct != null && (
        <div className={`eval-kpi__bar eval-kpi__bar--${barVariant || 'default'}`}>
          <span style={{ width: `${barPct}%` }} />
        </div>
      )}
    </div>
  )
}

export const AgentsPage = ({ onAgentClick }: { onAgentClick?: (agentId: string) => void }) => {
  const { agents, loading, error } = useEvalAgents()
  const [query, setQuery] = useState('')
  const [fwFilter, setFwFilter] = useState('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'last_run_at', dir: 'desc' })
  const [trendStyle] = useState<TrendStyle>('dots')

  const UNKNOWN_AGENT_ID = '__unknown__'

  const frameworks = useMemo(
    () => ['all', ...new Set(agents.map(a => a.framework).filter(Boolean) as string[])],
    [agents]
  )

  const filtered = useMemo(() => {
    let rows = agents.filter(a =>
      (fwFilter === 'all' || a.framework === fwFilter) &&
      (query === '' || (a.agent_id ?? '').toLowerCase().includes(query.toLowerCase()))
    )
    rows = [...rows].sort((a, b) => {
      const dir = sort.dir === 'asc' ? 1 : -1
      switch (sort.key) {
        case 'agent_id': return ((a.agent_id ?? '') < (b.agent_id ?? '') ? -1 : 1) * dir
        case 'last_run_at': return (new Date(a.last_run_at).getTime() - new Date(b.last_run_at).getTime()) * dir
        case 'avg_pass_rate': return (a.avg_pass_rate - b.avg_pass_rate) * dir
        case 'ttft_p95_ms': return ((a.ttft_p95_ms ?? 0) - (b.ttft_p95_ms ?? 0)) * dir
        case 'run_count': return (a.run_count - b.run_count) * dir
        default: return 0
      }
    })
    return rows
  }, [agents, query, fwFilter, sort])

  const stats = useMemo(() => {
    const totalRuns = agents.reduce((s, a) => s + a.run_count, 0)
    const avgPass = agents.length ? agents.reduce((s, a) => s + a.avg_pass_rate, 0) / agents.length : 0
    const p95Values = agents.map(a => a.ttft_p95_ms).filter((v): v is number => v != null)
    const avgP95 = p95Values.length ? p95Values.reduce((s, v) => s + v, 0) / p95Values.length : null
    // Synthetic 14-day sparkline series for visual
    const passSeries = Array.from({ length: 14 }, (_, i) => 40 + 25 * Math.sin(i / 2.3) + i / 3)
    const p95Series = Array.from({ length: 14 }, (_, i) => Math.max(0, 400 + 300 * Math.cos(i / 3)))
    return { totalRuns, avgPass, avgP95, passSeries, p95Series }
  }, [agents])

  const setSort_ = (key: SortKey) =>
    setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sort.key !== k) return null
    return sort.dir === 'desc'
      ? <ChevronDown size={12} />
      : <ChevronUp size={12} />
  }

  const renderTrend = (trend: AgentRow['trend']) => {
    if (!trend.length) return <span style={{ color: 'hsl(var(--muted-foreground))' }}>—</span>
    if (trendStyle === 'bars') return <TrendBars trend={trend} />
    if (trendStyle === 'spark') return <TrendSpark trend={trend} />
    return <TrendDots trend={trend} />
  }

  return (
    <div className="w-full p-6 flex flex-col gap-0 min-w-0">
      <div className="flex items-center justify-between" style={{ marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontFamily: 'var(--font-sans)', fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }}>
            Evals
          </h1>
          <div style={{ color: 'hsl(var(--muted-foreground))', fontSize: 13, marginTop: 4 }}>
            {agents.length} agents under test · {stats.totalRuns} runs
          </div>
        </div>
      </div>

      <div className="eval-kpi-grid">
        <KpiTile
          label="Avg pass rate"
          value={`${stats.avgPass.toFixed(1)}`}
          unit="%"
          sparkValues={stats.passSeries}
          sparkColor="hsl(142 70% 28%)"
          barPct={stats.avgPass}
          barVariant="pass"
        />
        <KpiTile
          label="p95 TTFT"
          value={stats.avgP95 != null ? formatMs(stats.avgP95) : '—'}
          sparkValues={stats.p95Series}
          sparkColor="hsl(210 90% 42%)"
          barPct={64}
          barVariant="info"
        />
        <KpiTile
          label="Runs"
          value={stats.totalRuns.toString()}
          barPct={44}
        />
        <KpiTile
          label="Agents"
          value={agents.length.toString()}
          barPct={agents.length}
        />
      </div>

      {error && (
        <div role="alert" className="border border-border bg-muted text-foreground px-4 py-2.5 rounded-lg text-s-400" style={{ marginBottom: 12 }}>
          Failed to load agents: {error}
        </div>
      )}

      <div className="eval-toolbar">
        <div className="eval-search">
          <Search size={14} color="hsl(var(--muted-foreground))" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search agents…"
          />
        </div>
        {frameworks.length > 1 && (
          <div className="eval-seg">
            {frameworks.map(f => (
              <button key={f} type="button" aria-pressed={fwFilter === f ? "true" : "false"} onClick={() => setFwFilter(f)}>{f}</button>
            ))}
          </div>
        )}
      </div>

      <div style={{ borderRadius: 10, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 12.5 }}>
          <thead>
            <tr>
              {[
                { k: 'agent_id' as SortKey, label: 'Agent' },
                { k: 'last_run_at' as SortKey, label: 'Last run' },
                { label: 'Trend' },
                { k: 'avg_pass_rate' as SortKey, label: 'Pass rate' },
                { k: 'ttft_p95_ms' as SortKey, label: 'p95 TTFT' },
                { k: 'run_count' as SortKey, label: 'Runs' },
                { label: 'Framework' },
                { label: '' },
              ].map(({ k, label }, i) => (
                <th
                  key={i}
                  onClick={k ? () => setSort_(k) : undefined}
                  style={{
                    padding: '10px 14px',
                    textAlign: 'left',
                    fontWeight: 500,
                    color: 'hsl(var(--muted-foreground))',
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    borderBottom: '1px solid hsl(var(--border))',
                    background: 'hsl(var(--card))',
                    cursor: k ? 'pointer' : 'default',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span className={k ? 'eval-th-sort' : ''} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {label}{k && <SortIcon k={k} />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} style={{ padding: '24px 14px', textAlign: 'center', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                  Loading agents…
                </td>
              </tr>
            )}
            {!loading && filtered.map(a => {
              const agentId = a.agent_id ?? UNKNOWN_AGENT_ID
              return (
                <tr
                  key={agentId}
                  onClick={() => onAgentClick?.(agentId)}
                  style={{ cursor: 'pointer', transition: 'background 100ms ease' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'hsl(var(--muted))')}
                  onMouseLeave={e => (e.currentTarget.style.background = '')}
                >
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono)', fontWeight: 500, fontSize: 12.5 }}>
                      <Bot size={14} color="hsl(var(--muted-foreground))" style={{ flexShrink: 0 }} />
                      {a.agent_id ?? <em style={{ color: 'hsl(var(--muted-foreground))' }}>unknown</em>}
                    </span>
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                    {formatDate(a.last_run_at)}
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))' }}>
                    {renderTrend(a.trend)}
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))' }}>
                    <PassRateCell rate={a.avg_pass_rate} prevRate={a.last_pass_rate} />
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    {a.ttft_p95_ms != null
                      ? <span style={{ color: a.ttft_p95_ms > 10000 ? 'hsl(var(--destructive))' : 'hsl(var(--foreground))' }}>{formatMs(a.ttft_p95_ms)}</span>
                      : <span style={{ color: 'hsl(var(--muted-foreground))' }}>—</span>}
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--font-mono)', fontSize: 12, textAlign: 'right' }}>
                    {a.run_count}
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))' }}>
                    {a.framework
                      ? <span className="eval-fw-pill"><Bot size={10} />{a.framework}</span>
                      : <span style={{ color: 'hsl(var(--muted-foreground))' }}>—</span>}
                  </td>
                  <td style={{ padding: '0 14px', height: 40, borderBottom: '1px solid hsl(var(--border))', width: 24, color: 'hsl(var(--muted-foreground))' }}>
                    <ChevronRight size={14} />
                  </td>
                </tr>
              )
            })}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: '24px 14px', textAlign: 'center', color: 'hsl(var(--muted-foreground))' }}>
                  No agents found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
