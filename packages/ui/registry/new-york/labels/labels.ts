/**
 * Display-name + icon registries for enum-shaped values that appear in
 * the UI.
 *
 * Single source of truth so a new surface that wants to render, say, a
 * transport label doesn't reinvent "audio_stream" → "Audio Stream".
 * Add new entries here when extending an enum; components below derive
 * from these.
 */

import {
  AudioLines,
  MessageSquare,
  Mic,
  Phone,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react'
import type { Modality, Transport } from './observability-types'


// ── Transports ──────────────────────────────────────────────────────────────

export const TRANSPORT_LABELS: Record<Transport, string> = {
  sip: 'SIP',
  audio_stream: 'Audio Stream',
  text: 'Text',
  terminal_text: 'Terminal',
}

export const TRANSPORT_ICONS: Record<Transport, LucideIcon> = {
  sip: Phone,
  audio_stream: AudioLines,
  text: MessageSquare,
  terminal_text: TerminalSquare,
}

/** Look up the display label for a transport value. Returns the raw
 *  string for unknown/future values so the UI is forward-compatible. */
export function transportLabel(value: string | null | undefined): string {
  if (!value) return ''
  return (TRANSPORT_LABELS as Record<string, string>)[value] ?? value
}

/** Icon component for a transport. Returns null for unknown values so
 *  the caller can decide how to render text-only. */
export function transportIcon(value: string | null | undefined): LucideIcon | null {
  if (!value) return null
  return (TRANSPORT_ICONS as Record<string, LucideIcon>)[value] ?? null
}


// ── Modality ────────────────────────────────────────────────────────────────

export const MODALITY_LABELS: Record<Exclude<Modality, null>, string> = {
  voice: 'Voice',
  text: 'Text',
  mixed: 'Mixed',
}

/** Modality icons. `mixed` deliberately has no single icon — callers
 *  composite voice + text icons together for that case. The Mic icon
 *  is used for voice modality so it's visually distinct from the
 *  AudioLines (waveform) icon used for the `audio_stream` transport —
 *  one says "this agent speaks", the other says "audio data is flowing". */
export const MODALITY_ICONS: Record<'voice' | 'text', LucideIcon> = {
  voice: Mic,
  text: MessageSquare,
}

export function modalityLabel(value: Modality | string | null | undefined): string {
  if (!value) return ''
  return (MODALITY_LABELS as Record<string, string>)[value] ?? String(value)
}
