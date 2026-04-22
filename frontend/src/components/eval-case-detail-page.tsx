import { useMemo } from 'react'
import { ArrowLeft, AlertTriangle, AudioWaveform, Clock, Repeat, X } from 'lucide-react'
import { StatusChip } from '@/components/obs-cells'
import { EvalEventTimeline } from '@/components/eval-event-timeline'
import { formatDuration, formatMs } from '@/lib/observability-format'
import { useEvalCase } from '@/lib/observability-hooks'
import type { RunEvent } from '@/lib/observability-types'

interface MetricsSummary {
  turnsWithMetrics: number
  avgTtftMs: number | null
  totalSpeakingMs: number | null
}

function computeCaseMetrics(events: RunEvent[]): MetricsSummary {
  const ttfts: number[] = []
  let speakingMs = 0
  let turns = 0
  for (const ev of events) {
    if (ev.type !== 'message') continue
    const metrics = (ev as { metrics?: Record<string, number | string | null> | null }).metrics
    if (!metrics) continue
    turns += 1
    const ttft = metrics.llm_node_ttft
    if (typeof ttft === 'number') ttfts.push(ttft * 1000)
    const start = metrics.started_speaking_at
    const stop = metrics.stopped_speaking_at
    if (typeof start === 'number' && typeof stop === 'number' && stop >= start) {
      speakingMs += (stop - start) * 1000
    }
  }
  return {
    turnsWithMetrics: turns,
    avgTtftMs: ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null,
    totalSpeakingMs: speakingMs > 0 ? speakingMs : null,
  }
}

function DrawerStatTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="s">
      <div className="k">
        {icon} {label}
      </div>
      <div className="v">{value}</div>
    </div>
  )
}

export const EvalCaseDetailPage = ({
  runId,
  caseId,
  onBack,
}: {
  runId: string
  caseId: string
  onBack?: () => void
}) => {
  const { evalCase, loading, error } = useEvalCase(runId, caseId)
  const summary = useMemo(
    () => (evalCase ? computeCaseMetrics(evalCase.events) : null),
    [evalCase],
  )

  if (loading) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: 'hsl(var(--tertiary))' }}>
        Loading case…
      </div>
    )
  }

  if (error || !evalCase) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: 'hsl(var(--destructive))' }}>
        <p>Failed to load case: {error ?? 'not found'}</p>
      </div>
    )
  }

  return (
    <>
      <div className="drawer-top">
        <button
          type="button"
          className="obs-back"
          onClick={onBack}
          style={{ margin: 0 }}
        >
          <ArrowLeft size={12} /> Back to run
        </button>
        <button type="button" className="x" onClick={onBack} aria-label="Close">
          <X size={14} />
        </button>
      </div>

      <div className="drawer-body">
        <div className="drawer-h">
          <span className="nm">{evalCase.name}</span>
          <StatusChip status={evalCase.status} />
        </div>
        <div className="drawer-meta">
          {evalCase.file && <span>{evalCase.file}</span>}
          {evalCase.file && <span> · </span>}
          <span>{formatDuration(evalCase.duration_ms)}</span>
          {evalCase.events.length > 0 && (
            <>
              <span> · </span>
              <span>{evalCase.events.length} event{evalCase.events.length !== 1 ? 's' : ''}</span>
            </>
          )}
          {evalCase.judgments.length > 0 && (
            <>
              <span> · </span>
              <span>{evalCase.judgments.length} judgment{evalCase.judgments.length !== 1 ? 's' : ''}</span>
            </>
          )}
        </div>

        {summary && summary.turnsWithMetrics > 0 && (
          <div className="drawer-stats">
            <DrawerStatTile
              icon={<Clock size={10} />}
              label="Avg TTFT"
              value={summary.avgTtftMs != null ? formatMs(summary.avgTtftMs) : '—'}
            />
            <DrawerStatTile
              icon={<AudioWaveform size={10} />}
              label="Agent spoke"
              value={summary.totalSpeakingMs != null ? formatMs(summary.totalSpeakingMs) : '—'}
            />
            <DrawerStatTile
              icon={<Repeat size={10} />}
              label="Turns w/ metrics"
              value={String(summary.turnsWithMetrics)}
            />
          </div>
        )}

        {evalCase.user_input && (
          <>
            <div className="section-label">User input</div>
            <div className="user-msg">{evalCase.user_input}</div>
          </>
        )}

        <div className="section-label">Transcript</div>
        <EvalEventTimeline events={evalCase.events} />

        {evalCase.judgments.length > 0 && (
          <>
            <div className="section-label">Judgments</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {evalCase.judgments.map((j, i) => {
                const chipVariant =
                  j.verdict === 'pass' ? 'passed' : j.verdict === 'fail' ? 'failed' : 'errored'
                return (
                  <div
                    key={`${j.intent}-${i}`}
                    style={{
                      border: j.verdict === 'fail' ? '1px solid #FECACA' : '1px solid hsl(var(--border))',
                      background: j.verdict === 'fail' ? '#FFF8F8' : 'transparent',
                      borderRadius: 8,
                      padding: '10px 12px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                      <p style={{ font: 'var(--text-s-500)', margin: 0 }}>{j.intent}</p>
                      <span className={`status-chip ${chipVariant}`}>{j.verdict}</span>
                    </div>
                    {j.reasoning && (
                      <p
                        style={{
                          marginTop: 8,
                          font: 'var(--text-s-400)',
                          color: 'hsl(var(--secondary))',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {j.reasoning}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {evalCase.failure && (
          <div className="fail-block">
            <div className="hd">
              <AlertTriangle size={14} /> Failure ({evalCase.failure.kind})
            </div>
            {evalCase.failure.message && <div className="msg">{evalCase.failure.message}</div>}
            {evalCase.failure.stack && (
              <details style={{ marginTop: 8 }}>
                <summary className="stack">Stack trace</summary>
                <pre className="ctx" style={{ marginTop: 8 }}>
                  {evalCase.failure.stack}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </>
  )
}
