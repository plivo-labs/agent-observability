/**
 * Shared Neo-styled cell renderers used by list pages. Keep these small and
 * class-driven — the styles live in `styles/observability.css`.
 */

import {
  FlaskConical,
  TriangleAlert,
} from 'lucide-react'
import type { CaseStatus, Modality, Transport } from '@/lib/observability-types'
import { Badge } from '@/components/ui/badge'
import { formatDuration } from '@/lib/observability-format'
import {
  MODALITY_ICONS,
  MODALITY_LABELS,
  modalityLabel,
  TRANSPORT_LABELS,
  transportIcon,
  transportLabel,
} from '@/lib/labels'

export function CapsChips({
  stt, llm, tts,
}: { stt: boolean; llm: boolean; tts: boolean }) {
  const capabilities = [
    stt && { label: 'STT', className: 'cap-stt' },
    llm && { label: 'LLM', className: 'cap-llm' },
    tts && { label: 'TTS', className: 'cap-tts' },
  ].filter(Boolean) as Array<{ label: string; className: string }>

  if (capabilities.length === 0) {
    return <span className="muted">—</span>
  }

  return (
    <div className="caps">
      {capabilities.map((capability) => (
        <span key={capability.label} className={`cap ${capability.className}`}>
          {capability.label}
        </span>
      ))}
    </div>
  )
}

/**
 * Modality chip. Derived in SQL on agents from the set of session
 * transports. Used both as a cell in the agents table and as the
 * primary detail badge in the agent dashboard header — extracted here
 * so the two surfaces stay visually identical.
 */
export function ModalityChip({
  value,
  size = 'sm',
}: {
  value: Modality
  /** `sm` is the table-cell size; `md` is the agent-detail-header size. */
  size?: 'sm' | 'md'
}) {
  if (!value) return <span className="muted">—</span>
  const iconSize = size === 'sm' ? 12 : 14
  const className =
    size === 'sm'
      ? 'gap-1 px-1.5 text-[10px]'
      : 'gap-1 px-2 py-0.5 text-xs'
  if (value === 'voice') {
    const Icon = MODALITY_ICONS.voice
    return (
      <Badge variant="outline" className={className}>
        <Icon size={iconSize} /> {MODALITY_LABELS.voice}
      </Badge>
    )
  }
  if (value === 'text') {
    const Icon = MODALITY_ICONS.text
    return (
      <Badge variant="outline" className={className}>
        <Icon size={iconSize} /> {MODALITY_LABELS.text}
      </Badge>
    )
  }
  // mixed — composite both modality icons so the chip visually
  // says "voice + text". Label still flows through the registry.
  const VoiceIcon = MODALITY_ICONS.voice
  const TextIcon = MODALITY_ICONS.text
  return (
    <Badge variant="outline" className={className}>
      <VoiceIcon size={iconSize} />
      <TextIcon size={iconSize} /> {MODALITY_LABELS.mixed}
    </Badge>
  )
}

export function TransportPill({ value }: { value: Transport | null }) {
  if (!value) return <span className="muted">—</span>
  const Icon = transportIcon(value)
  const label = transportLabel(value)
  return (
    <span className="transport">
      {Icon && <Icon size={12} />} {label}
    </span>
  )
}

/**
 * Outline-badge form of TransportPill. Used in compact contexts (agent
 * detail header) where we want the same icon + label semantics but a
 * filled-border badge instead of the `.transport` chip styling.
 */
export function TransportBadge({
  value,
  size = 'sm',
}: {
  value: Transport | string | null
  size?: 'sm' | 'md'
}) {
  if (!value) return null
  const Icon = transportIcon(value)
  const label = transportLabel(value)
  const iconSize = size === 'sm' ? 12 : 14
  const className =
    size === 'sm'
      ? 'gap-1 px-1.5 text-[10px] font-normal'
      : 'gap-1 px-2 py-0.5 text-xs font-normal'
  return (
    <Badge variant="outline" className={className}>
      {Icon && <Icon size={iconSize} />} {label}
    </Badge>
  )
}

// Re-exported so callers that just want the string label don't have to
// reach all the way into @/lib/labels.
export { TRANSPORT_LABELS, transportLabel, modalityLabel }

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
