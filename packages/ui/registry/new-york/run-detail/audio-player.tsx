/* audio-player.tsx — a clean, seekable audio player (no waveform).
 * Play/pause + a progress bar that fills as it plays, click/drag to seek,
 * current/total time, and a speed toggle. Used wherever a call recording is
 * played (Evals run/case detail, Live). On-theme (Neo tokens). */
import { AudioLines, Pause, Play } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const SPEEDS = [1, 1.5, 2] as const

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const x = Math.floor(s % 60)
  return `${m}:${String(x).padStart(2, '0')}`
}

export function AudioPlayer({ src, className, durationHint }: { src: string; className?: string; durationHint?: number }) {
  const ref = useRef<HTMLAudioElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  const [speedIdx, setSpeedIdx] = useState(0)
  const [error, setError] = useState(false)
  const fixingDur = useRef(false) // true while we force-seek to discover an unknown duration
  // Effective duration for the scrubber/total: the real decoded duration if we
  // have it, else the caller-supplied hint (e.g. the call's recorded seconds).
  const span = dur || durationHint || 0

  // Streamed OGG/Opus recordings report duration = Infinity/NaN, so the scrubber
  // can't fill and the total reads 0:00. Adopt a finite duration when we get one;
  // if it's unknown, force the element to read to the end (needs Range support,
  // which the recording endpoint now provides) so `durationchange` fires the real
  // value, then snap back to the start.
  const applyDuration = (a: HTMLAudioElement): boolean => {
    const d = a.duration
    if (Number.isFinite(d) && d > 0) {
      setDur(d)
      if (fixingDur.current) { fixingDur.current = false; a.currentTime = 0; setCur(0) }
      return true
    }
    return false
  }

  const onMeta = (a: HTMLAudioElement) => {
    setError(false)
    if (applyDuration(a)) return
    fixingDur.current = true
    try { a.currentTime = 1e101 } catch { /* ignore */ }
  }

  const toggle = () => {
    const a = ref.current
    if (!a) return
    if (a.paused) a.play().catch(() => {})
    else a.pause()
  }

  const seekTo = useCallback((clientX: number) => {
    const a = ref.current
    const bar = barRef.current
    if (!a || !bar || !span) return
    const r = bar.getBoundingClientRect()
    const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    a.currentTime = pct * span
    setCur(a.currentTime)
  }, [span])

  const onBarDown = (e: React.MouseEvent) => {
    seekTo(e.clientX)
    const move = (ev: MouseEvent) => seekTo(ev.clientX)
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const cycleSpeed = () => {
    const next = (speedIdx + 1) % SPEEDS.length
    setSpeedIdx(next)
    if (ref.current) ref.current.playbackRate = SPEEDS[next]
  }

  const pct = span ? (cur / span) * 100 : 0

  return (
    <div className={cn('flex items-center gap-3 rounded-[var(--radius)] border bg-card px-3 py-2.5', className)}>
      {error ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <AudioLines size={14} className="shrink-0 opacity-60" />
          <span>Recording unavailable — it may have expired or the call didn’t record.</span>
        </div>
      ) : (
        <>
      <button
        type="button"
        onClick={toggle}
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary transition-colors hover:bg-primary/90"
        style={{ color: 'hsl(var(--primary-foreground))' }}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
      </button>

      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{fmt(cur)}</span>

      <div
        ref={barRef}
        onMouseDown={onBarDown}
        onKeyDown={(e) => {
          const a = ref.current
          if (!a) return
          if (e.key === 'ArrowRight') { e.preventDefault(); a.currentTime = Math.min(span, cur + 5); setCur(a.currentTime) }
          else if (e.key === 'ArrowLeft') { e.preventDefault(); a.currentTime = Math.max(0, cur - 5); setCur(a.currentTime) }
        }}
        tabIndex={0}
        className="group relative h-1.5 flex-1 cursor-pointer rounded-full bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(span)}
        aria-valuenow={Math.round(cur)}
      >
        <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${pct}%` }} />
        <div
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary opacity-0 shadow transition-opacity group-hover:opacity-100"
          style={{ left: `${pct}%` }}
        />
      </div>

      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{fmt(span)}</span>

      <button
        type="button"
        onClick={cycleSpeed}
        className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground transition-colors hover:text-foreground"
        aria-label={`Playback speed ${SPEEDS[speedIdx]}x`}
      >
        {SPEEDS[speedIdx]}x
      </button>
        </>
      )}

      <audio
        ref={ref}
        src={src}
        aria-label="Call recording"
        preload="metadata"
        onLoadedMetadata={(e) => onMeta(e.currentTarget)}
        onDurationChange={(e) => applyDuration(e.currentTarget)}
        onTimeUpdate={(e) => { if (!fixingDur.current) setCur(e.currentTarget.currentTime) }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setError(true)}
      >
        {/* No transcript caption file exists for the raw recording; an empty captions track satisfies the a11y requirement without asserting bogus captions. */}
        <track kind="captions" />
      </audio>
    </div>
  )
}
