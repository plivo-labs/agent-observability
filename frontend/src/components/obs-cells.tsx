/**
 * Shared Neo-styled cell renderers used by list pages. Keep these small and
 * class-driven — the styles live in `styles/observability.css`.
 */

import { AudioLines, Phone, TriangleAlert } from 'lucide-react'
import type { Transport } from '@/lib/observability-types'
import { formatDuration } from '@/lib/observability-format'

export function CapsChips({
  stt, llm, tts,
}: { stt: boolean; llm: boolean; tts: boolean }) {
  return (
    <div className="caps">
      <span className={`cap ${stt ? 'cap-stt' : 'cap-off'}`}>STT</span>
      <span className={`cap ${llm ? 'cap-llm' : 'cap-off'}`}>LLM</span>
      <span className={`cap ${tts ? 'cap-tts' : 'cap-off'}`}>TTS</span>
    </div>
  )
}

export function TransportPill({ value }: { value: Transport | null }) {
  if (value === 'sip') {
    return (
      <span className="transport">
        <Phone size={12} /> SIP
      </span>
    )
  }
  if (value === 'audio_stream') {
    return (
      <span className="transport">
        <AudioLines size={12} /> Audio Stream
      </span>
    )
  }
  return <span className="muted">—</span>
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
      <span className="dur-bad">
        <TriangleAlert size={12} /> invalid
      </span>
    )
  }
  return <span className="mono tnum">{formatDuration(ms)}</span>
}

/** Turns count with an inline fill-bar proportional to `maxTurns`. */
export function TurnsBar({ turns, maxTurns }: { turns: number; maxTurns: number }) {
  const pct = maxTurns > 0 ? Math.min(100, (turns / maxTurns) * 100) : 0
  return (
    <span className="turns-cell">
      <span className="bar"><i style={{ width: `${pct}%` }} /></span>
      <b style={{ fontWeight: 600 }}>{turns}</b>
    </span>
  )
}
