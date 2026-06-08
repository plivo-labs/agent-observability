/**
 * Shared Neo-styled cell renderers used by list pages. Keep these small and
 * class-driven — the styles live in `styles/observability.css`.
 */

import { AudioLines, MessageSquare, Phone, TriangleAlert } from 'lucide-react'
import type { Transport } from '@/lib/observability-types'
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

const TRANSPORT_META: Record<string, { label: string; Icon: typeof Phone }> = {
  sip: { label: 'SIP', Icon: Phone },
  phone: { label: 'Phone', Icon: Phone },
  audio_stream: { label: 'Audio Stream', Icon: AudioLines },
  text: { label: 'Text', Icon: MessageSquare },
  terminal_text: { label: 'Terminal Text', Icon: MessageSquare },
}

export function TransportPill({ value }: { value: Transport | null }) {
  if (!value) return <span className="ao-mono muted">—</span>
  const meta = TRANSPORT_META[value]
  if (meta) {
    const { label, Icon } = meta
    return (
      <span className="ao-badge is-neutral">
        <Icon size={12} /> {label}
      </span>
    )
  }
  // Known-present but unmapped transport — surface the raw value rather than
  // swallowing it to "—" (which hid text/terminal_text/phone sessions).
  return <span className="ao-badge is-neutral">{value}</span>
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
