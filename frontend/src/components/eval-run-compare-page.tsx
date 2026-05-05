import { useMemo } from 'react'
import { Download } from 'lucide-react'
import { Link } from 'react-router'
import { useEvalRun } from '@/lib/observability-hooks'
import { formatMs, formatTokens, formatCost, formatDuration } from '@/lib/observability-format'
import type { EvalCaseRow } from '@/lib/observability-types'

function StatusPill({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    passed: ['pass', 'passed'],
    failed: ['fail', 'failed'],
    errored: ['warn', 'errored'],
    skipped: ['', 'skipped'],
  }
  const [variant, label] = map[status] ?? ['', status]
  return (
    <span className={`eval-status-pill eval-status-pill--${variant || 'default'}`}>
      <span className="dot" />
      {label}
    </span>
  )
}

function metricDelta(a: number | null, b: number | null, lowerIsBetter = false) {
  if (a == null || b == null) return null
  const d = b - a
  const pct = a === 0 ? 0 : (d / a) * 100
  const good = lowerIsBetter ? d < 0 : d > 0
  return { d, pct, good }
}

function KpiTile({ label, a, b, fmtFn, lowerIsBetter = false }: {
  label: string
  a: number | null
  b: number | null
  fmtFn: (v: number | null) => string
  lowerIsBetter?: boolean
}) {
  const delta = metricDelta(a, b, lowerIsBetter)
  const maxVal = Math.max(Math.abs(a ?? 0), Math.abs(b ?? 0))
  const pctA = maxVal > 0 ? ((a ?? 0) / maxVal) * 100 : 0
  const pctB = maxVal > 0 ? ((b ?? 0) / maxVal) * 100 : 0
  return (
    <div className="eval-compare-kpi-tile">
      <div className="lbl">{label}</div>
      <div className="vals">
        <span className="val-a">{fmtFn(a)}</span>
        <span className="arrow">→</span>
        <span className="val-b">{fmtFn(b)}</span>
      </div>
      <div className="bars">
        <span className="bar bar--a" style={{ width: `${pctA}%` }} />
        <span className="bar bar--b" style={{ width: `${pctB}%` }} />
      </div>
      {delta && (
        <div className={`delta ${delta.good ? 'delta--up' : 'delta--down'}`}>
          {delta.d > 0 ? '▲' : '▼'} {Math.abs(delta.pct).toFixed(1)}%
        </div>
      )}
    </div>
  )
}

interface DiffItem {
  key: string
  a: EvalCaseRow | undefined
  b: EvalCaseRow | undefined
  kind: 'regress' | 'fixed' | 'failing' | 'unchanged' | 'new' | 'removed'
  ttftDelta: number | null
}

export function EvalRunComparePage({
  agentId,
  runIdA,
  runIdB,
  onBack: _onBack,
  onOpenRun,
}: {
  agentId: string
  runIdA?: string
  runIdB?: string
  onBack?: () => void
  onOpenRun?: (runId: string) => void
}) {
  const { run: runA, loading: loadingA } = useEvalRun(runIdA)
  const { run: runB, loading: loadingB } = useEvalRun(runIdB)

  const diffs = useMemo<DiffItem[]>(() => {
    if (!runA || !runB) return []
    const casesA = runA.cases ?? []
    const casesB = runB.cases ?? []
    const byNameA: Record<string, EvalCaseRow> = {}
    const byNameB: Record<string, EvalCaseRow> = {}
    for (const c of casesA) byNameA[c.name] = c
    for (const c of casesB) byNameB[c.name] = c
    const allKeys = [...new Set([...Object.keys(byNameA), ...Object.keys(byNameB)])]
    return allKeys.map(k => {
      const a = byNameA[k], b = byNameB[k]
      const aPassed = a?.status === 'passed'
      const bPassed = b?.status === 'passed'
      let kind: DiffItem['kind'] = 'unchanged'
      if (a && b) {
        if (aPassed && !bPassed) kind = 'regress'
        else if (!aPassed && bPassed) kind = 'fixed'
        else if (!aPassed && !bPassed) kind = 'failing'
        else kind = 'unchanged'
      } else if (!a && b) {
        kind = 'new'
      } else if (a && !b) {
        kind = 'removed'
      }
      const ttftDelta = (a?.ttft_p50_ms != null && b?.ttft_p50_ms != null)
        ? b.ttft_p50_ms - a.ttft_p50_ms
        : null
      return { key: k, a, b, kind, ttftDelta }
    })
  }, [runA, runB])

  const regressions = diffs.filter(d => d.kind === 'regress')
  const fixes = diffs.filter(d => d.kind === 'fixed')
  const stillFailing = diffs.filter(d => d.kind === 'failing')
  const unchanged = diffs.filter(d => d.kind === 'unchanged')
  const newCases = diffs.filter(d => d.kind === 'new')
  const removedCases = diffs.filter(d => d.kind === 'removed')

  const passRateA = runA && runA.total > 0 ? runA.passed / runA.total : 0
  const passRateB = runB && runB.total > 0 ? runB.passed / runB.total : 0

  const verdictKind = passRateB < passRateA ? 'regress'
    : passRateB > passRateA ? 'improve'
    : 'neutral'
  const verdictText = verdictKind === 'regress'
    ? `Pass rate dropped ${((passRateA - passRateB) * 100).toFixed(0)}pp`
    : verdictKind === 'improve'
    ? `Pass rate improved ${((passRateB - passRateA) * 100).toFixed(0)}pp`
    : 'No net change in pass rate'
  const verdictSub = `${fixes.length} fixed · ${regressions.length} regressed · ${stillFailing.length} still failing · ${unchanged.length} unchanged${newCases.length ? ` · ${newCases.length} new` : ''}${removedCases.length ? ` · ${removedCases.length} removed` : ''}`

  function fmtStarted(iso: string | null): string {
    if (!iso) return '—'
    const d = new Date(iso)
    const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    let h = d.getHours(); const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12; if (h === 0) h = 12
    return `${m[d.getMonth()]} ${d.getDate()} · ${h}:${String(d.getMinutes()).padStart(2,'0')}${ampm}`
  }

  const DiffRow = ({ d }: { d: DiffItem }) => {
    const c = d.b || d.a
    const markerCls = d.kind === 'regress' ? 'marker--regress' : d.kind === 'fixed' ? 'marker--fixed' : d.kind === 'failing' ? 'marker--failing' : ''
    const markerChar = d.kind === 'regress' ? '✗' : d.kind === 'fixed' ? '✓' : d.kind === 'failing' ? '!' : '–'
    return (
      <div className="eval-diff-row" onClick={() => c && onOpenRun?.(c.run_id)}>
        <span className={`marker ${markerCls}`}>{markerChar}</span>
        <span className="name" title={c?.name ?? d.key}>{c?.name ?? d.key}</span>
        <span>{d.a ? <StatusPill status={d.a.status} /> : <span style={{ color: 'hsl(var(--muted-foreground))' }}>—</span>}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
          <span style={{ color: 'hsl(var(--muted-foreground))' }}>→</span>
          {d.b ? <StatusPill status={d.b.status} /> : <span style={{ color: 'hsl(var(--muted-foreground))' }}>—</span>}
        </span>
        <span className="mono-pair" style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
          {d.a?.ttft_p50_ms != null && d.b?.ttft_p50_ms != null ? (
            <>
              <span style={{ color: 'hsl(var(--muted-foreground))' }}>{formatMs(d.a.ttft_p50_ms)}</span>
              <span style={{ color: 'hsl(var(--muted-foreground))' }}>→</span>
              <span>{formatMs(d.b.ttft_p50_ms)}</span>
            </>
          ) : <span style={{ color: 'hsl(var(--muted-foreground))' }}>—</span>}
        </span>
        <span className={`ttft-delta ${d.ttftDelta != null && d.ttftDelta < 0 ? 'ttft-delta--up' : d.ttftDelta != null && d.ttftDelta > 0 ? 'ttft-delta--down' : ''}`}>
          {d.ttftDelta != null ? `${d.ttftDelta > 0 ? '+' : ''}${formatMs(Math.abs(d.ttftDelta))}` : ''}
        </span>
      </div>
    )
  }

  if (loadingA || loadingB) {
    return (
      <div className="w-full p-6">
        <div className="eval-breadcrumbs">
          <Link to="/evals">Evals</Link>
          <span className="eval-breadcrumbs__sep">/</span>
          <Link to={`/evals/agents/${encodeURIComponent(agentId)}`}>{agentId}</Link>
          <span className="eval-breadcrumbs__sep">/</span>
          <span className="eval-breadcrumbs__current">Compare</span>
        </div>
        <div style={{ padding: '40px', textAlign: 'center', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          Loading runs…
        </div>
      </div>
    )
  }

  if (!runA || !runB) {
    return (
      <div className="w-full p-6">
        <div className="eval-breadcrumbs">
          <Link to="/evals">Evals</Link>
          <span className="eval-breadcrumbs__sep">/</span>
          <Link to={`/evals/agents/${encodeURIComponent(agentId)}`}>{agentId}</Link>
          <span className="eval-breadcrumbs__sep">/</span>
          <span className="eval-breadcrumbs__current">Compare</span>
        </div>
        <div style={{ padding: '40px', textAlign: 'center', color: 'hsl(var(--muted-foreground))' }}>
          {!runIdA || !runIdB ? 'Select two runs to compare.' : 'Failed to load one or both runs.'}
        </div>
      </div>
    )
  }

  return (
    <div className="w-full p-6 flex flex-col gap-0 min-w-0">
      <div className="eval-breadcrumbs">
        <Link to="/evals">Evals</Link>
        <span className="eval-breadcrumbs__sep">/</span>
        <Link to={`/evals/agents/${encodeURIComponent(agentId)}`}>{agentId}</Link>
        <span className="eval-breadcrumbs__sep">/</span>
        <span className="eval-breadcrumbs__current">Compare</span>
      </div>

      <div className="flex items-start justify-between" style={{ marginTop: 4, marginBottom: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <h1 style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 600 }}>{agentId}</h1>
            <span className="eval-status-pill eval-status-pill--accent">Comparing runs</span>
          </div>
          <div style={{ color: 'hsl(var(--muted-foreground))', fontSize: 13 }}>
            Side-by-side diff · regressions pinned at top
          </div>
        </div>
      </div>

      {/* Run A vs B cards */}
      <div className="eval-compare-header">
        <div className="eval-compare-card a">
          <div className="lbl">Run A · baseline</div>
          <div className="ttl">{fmtStarted(runA.started_at)}</div>
          <div className="sub">
            {runA.ci?.git_branch ?? 'main'}
            {runA.ci?.git_sha ? ` @${String(runA.ci.git_sha).slice(0, 7)}` : ''}
            {' · '}{runA.total} cases · {formatDuration(runA.duration_ms)}
          </div>
        </div>
        <div className="eval-compare-vs">VS</div>
        <div className="eval-compare-card b">
          <div className="lbl">Run B · candidate</div>
          <div className="ttl">{fmtStarted(runB.started_at)}</div>
          <div className="sub">
            {runB.ci?.git_branch ?? 'main'}
            {runB.ci?.git_sha ? ` @${String(runB.ci.git_sha).slice(0, 7)}` : ''}
            {' · '}{runB.total} cases · {formatDuration(runB.duration_ms)}
          </div>
        </div>
      </div>

      {/* Verdict */}
      <div className={`eval-verdict ${verdictKind}`}>
        <div className="eval-verdict__icon">
          {verdictKind === 'regress' ? '✗' : verdictKind === 'improve' ? '✓' : '–'}
        </div>
        <div>
          <div className="eval-verdict__title">{verdictText}</div>
          <div className="eval-verdict__sub">{verdictSub}</div>
        </div>
        <div style={{ flex: 1 }} />
        <button type="button" className="eval-action-btn">
          <Download size={14} /> Export diff
        </button>
      </div>

      {/* KPI deltas */}
      <div className="eval-compare-kpi">
        <KpiTile label="Pass rate" a={passRateA * 100} b={passRateB * 100} fmtFn={v => v != null ? `${v.toFixed(0)}%` : '—'} />
        <KpiTile label="p95 TTFT" a={runA.ttft_p95_ms} b={runB.ttft_p95_ms} fmtFn={v => v != null ? formatMs(v) : '—'} lowerIsBetter />
        <KpiTile label="Tokens" a={runA.total_tokens} b={runB.total_tokens} fmtFn={v => v != null ? formatTokens(v) : '—'} lowerIsBetter />
        <KpiTile label="Cost" a={runA.estimated_cost_usd} b={runB.estimated_cost_usd} fmtFn={v => v != null ? formatCost(v) : '—'} lowerIsBetter />
      </div>

      {/* Diff sections */}
      {regressions.length > 0 && (
        <div className="eval-diff-section">
          <div className="eval-diff-section__head regress">
            <span>✗ Regressed</span>
            <span className="count">{regressions.length}</span>
            <span style={{ fontWeight: 400, marginLeft: 8, color: 'hsl(var(--muted-foreground))' }}>passed in A, failed in B</span>
          </div>
          {regressions.map(d => <DiffRow key={d.key} d={d} />)}
        </div>
      )}

      {fixes.length > 0 && (
        <div className="eval-diff-section" style={{ marginTop: 8 }}>
          <div className="eval-diff-section__head fixed">
            <span>✓ Fixed</span>
            <span className="count">{fixes.length}</span>
            <span style={{ fontWeight: 400, marginLeft: 8, color: 'hsl(var(--muted-foreground))' }}>failed in A, passed in B</span>
          </div>
          {fixes.map(d => <DiffRow key={d.key} d={d} />)}
        </div>
      )}

      {stillFailing.length > 0 && (
        <div className="eval-diff-section" style={{ marginTop: 8 }}>
          <div className="eval-diff-section__head failing">
            <span>! Still failing</span>
            <span className="count">{stillFailing.length}</span>
            <span style={{ fontWeight: 400, marginLeft: 8, color: 'hsl(var(--muted-foreground))' }}>failed in both runs</span>
          </div>
          {stillFailing.map(d => <DiffRow key={d.key} d={d} />)}
        </div>
      )}

      {unchanged.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', padding: 8, fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
            ▸ {unchanged.length} unchanged cases (passed in both)
          </summary>
          <div className="eval-diff-section" style={{ marginTop: 4 }}>
            {unchanged.map(d => <DiffRow key={d.key} d={d} />)}
          </div>
        </details>
      )}

      {newCases.length > 0 && (
        <div className="eval-diff-section" style={{ marginTop: 8 }}>
          <div className="eval-diff-section__head" style={{ borderColor: 'hsl(var(--muted-foreground) / 0.3)' }}>
            <span>+ New cases</span>
            <span className="count">{newCases.length}</span>
            <span style={{ fontWeight: 400, marginLeft: 8, color: 'hsl(var(--muted-foreground))' }}>only in run B</span>
          </div>
          {newCases.map(d => <DiffRow key={d.key} d={d} />)}
        </div>
      )}

      {removedCases.length > 0 && (
        <div className="eval-diff-section" style={{ marginTop: 8 }}>
          <div className="eval-diff-section__head" style={{ borderColor: 'hsl(var(--muted-foreground) / 0.3)' }}>
            <span>− Removed cases</span>
            <span className="count">{removedCases.length}</span>
            <span style={{ fontWeight: 400, marginLeft: 8, color: 'hsl(var(--muted-foreground))' }}>only in run A</span>
          </div>
          {removedCases.map(d => <DiffRow key={d.key} d={d} />)}
        </div>
      )}

      {diffs.length === 0 && (
        <div style={{ padding: '40px', textAlign: 'center', color: 'hsl(var(--muted-foreground))' }}>
          No cases to compare.
        </div>
      )}
    </div>
  )
}
