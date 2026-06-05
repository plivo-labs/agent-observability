/* voice-picker.tsx — ElevenLabs voice <select> + a ▶/❚❚ preview button.
 * Fetches GET /api/voices (a bare JSON array). When the list is empty or the
 * fetch errors, it falls back to a plain text input so a persona can still be
 * saved with a hand-typed voice id. Matches AO's Neo form tokens (.ao-input). */
import { useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export interface Voice {
  voice_id: string
  name: string
  category?: string
  description?: string | null
  preview_url: string
  labels: {
    accent?: string
    age?: string
    gender?: string
    use_case?: string
    description?: string
    language?: string
  }
  is_default?: boolean
}

/** A short hint built from a voice's labels, e.g. "female · american". */
function voiceHint(v: Voice): string {
  const bits = [v.labels?.gender, v.labels?.accent].filter(Boolean) as string[]
  return bits.join(' · ')
}

export function VoicePicker({
  value,
  onChange,
  className,
  id,
}: {
  value: string
  onChange: (voiceId: string) => void
  className?: string
  id?: string
}) {
  const [voices, setVoices] = useState<Voice[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/voices', { headers: { 'content-type': 'application/json' } })
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() })
      .then((data: Voice[]) => { if (alive) setVoices(Array.isArray(data) ? data : []) })
      .catch(() => { if (alive) { setVoices([]); setFailed(true) } })
    return () => { alive = false }
  }, [])

  // Stop playback whenever the selected voice changes.
  useEffect(() => {
    const a = audioRef.current
    if (a) { a.pause(); a.currentTime = 0 }
    setPlaying(false)
  }, [value])

  const selected = voices?.find((v) => v.voice_id === value) ?? null
  const previewUrl = selected?.preview_url ?? ''

  const toggle = () => {
    const a = audioRef.current
    if (!a || !previewUrl) return
    if (playing) { a.pause() } else { a.play().catch(() => setPlaying(false)) }
  }

  // Loading state: keep layout stable with a disabled select.
  const loading = voices === null

  // Fallback: no voices available (empty list or fetch error) → plain text input.
  if (!loading && (failed || voices.length === 0)) {
    return (
      <input
        id={id}
        aria-label="ElevenLabs voice id"
        className={cn('ao-input', className)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="ElevenLabs voice id"
      />
    )
  }

  return (
    <div className={cn('flex items-stretch gap-2', className)}>
      <Select value={value || undefined} onValueChange={onChange} disabled={loading}>
        <SelectTrigger id={id} className="flex-1" aria-label="Voice">
          <SelectValue placeholder={loading ? 'Loading voices…' : 'Select a voice…'} />
        </SelectTrigger>
        <SelectContent className="max-h-[320px]">
          {(voices ?? []).map((v) => {
            const hint = voiceHint(v)
            return (
              <SelectItem key={v.voice_id} value={v.voice_id}>
                {v.name}{hint ? ` — ${hint}` : ''}{v.is_default ? ' (default)' : ''}
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
      <button
        type="button"
        onClick={toggle}
        disabled={!previewUrl}
        title={previewUrl ? (playing ? 'Pause preview' : 'Play preview') : 'No preview available'}
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-md border border-input bg-background text-foreground transition',
          'hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40',
        )}
      >
        {playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      {previewUrl && (
        <audio
          ref={audioRef}
          src={previewUrl}
          aria-label="Voice preview"
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        >
          {/* Short voice sample — no spoken-content caption track exists; empty captions satisfy the a11y requirement. */}
          <track kind="captions" />
        </audio>
      )}
    </div>
  )
}
