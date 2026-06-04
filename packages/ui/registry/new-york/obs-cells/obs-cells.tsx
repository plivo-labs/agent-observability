/**
 * Shared Neo-styled cell renderers used by list pages. Keep these small and
 * class-driven — the styles live in `styles/observability.css`.
 */

import { AudioLines, FlaskConical, Phone, TriangleAlert } from 'lucide-react'
import type { CaseStatus, Transport } from '@/lib/observability-types'
import { formatDuration } from '@/lib/observability-format'

export function CapsChips({
  stt, llm, tts,
}: { stt: boolean; llm: boolean; tts: boolean }) {
  if (!stt && !llm && !tts) {
    return <span className="ao-mono muted">—</span>
  }
  // Truman-inspired pipeline rail: render the whole STT → LLM → TTS pipeline,
  // lit stages = active, dim = absent — more legible than separate chips.
  const stages = [
    { label: 'STT', on: stt },
    { label: 'LLM', on: llm },
    { label: 'TTS', on: tts },
  ]
  return (
    <div className="ao-pipeline">
      {stages.map((s, i) => (
        <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center' }}>
          <span className={`ao-pipe-stage${s.on ? ' on' : ''}`}>
            <span className="dot" />{s.label}
          </span>
          {i < stages.length - 1 && (
            <span className={`ao-pipe-rail${s.on && stages[i + 1].on ? ' on' : ''}`} />
          )}
        </span>
      ))}
    </div>
  )
}

export function TransportPill({ value }: { value: Transport | null }) {
  if (value === 'sip') {
    return (
      <span className="ao-badge is-neutral">
        <Phone size={12} /> SIP
      </span>
    )
  }
  if (value === 'audio_stream') {
    return (
      <span className="ao-badge is-neutral">
        <AudioLines size={12} /> Audio Stream
      </span>
    )
  }
  return <span className="ao-mono muted">—</span>
}

/**
 * Duration cell. Renders the formatted value in mono/tabular-nums when
 * valid; shows a warning affordance when the underlying ms is negative
 * (the "invalid duration" row the design calls out — happens when the
 * upstream pipeline mis-computes ended-at - started-at).
 */
export function DurationCell({ ms }: { ms: number | null }) {
  if (ms != null && ms < 0) {
    return (
      <span className="ao-badge is-danger">
        <TriangleAlert size={12} /> invalid
      </span>
    )
  }
  return <span className="ao-mono tnum">{formatDuration(ms)}</span>
}

/** Framework pill (evals list) — `flask-conical` icon + name + muted version. */
export function FrameworkPill({
  name, version,
}: { name: string; version?: string | null }) {
  return (
    <span className="framework">
      <FlaskConical size={12} /> {name}
      {version && <span className="ver">{version}</span>}
    </span>
  )
}

/**
 * Pass-rate meter: numeric label + fill bar + "N failed" chip when any
 * case failed. Variant maps to design thresholds (95 / 70 / below).
 */
export function PassRate({
  passed, total, failed,
}: { passed: number; total: number; failed: number }) {
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0
  const variant = pct >= 95 ? 'good' : pct >= 70 ? 'warn' : 'bad'
  return (
    <div className={`passrate ${variant}`}>
      <span className="label">{pct}%</span>
      <span className="meter"><i style={{ width: `${pct}%` }} /></span>
      {failed > 0 && <span className="fail">{failed} failed</span>}
    </div>
  )
}

/** Eval case status chip — maps `.status-chip passed|failed|errored|skipped`. */
export function StatusChip({ status }: { status: CaseStatus }) {
  return <span className={`status-chip ${status}`}>{status}</span>
}
