/* audio-player.tsx — a clean, seekable audio player (no waveform).
 * Play/pause + a progress bar that fills as it plays, click/drag to seek,
 * current/total time, and a speed toggle. Used wherever a call recording is
 * played (Evals run/case detail, Live). On-theme (Neo tokens). */
import { Pause, Play } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const SPEEDS = [1, 1.5, 2] as const

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const x = Math.floor(s % 60)
  return `${m}:${String(x).padStart(2, '0')}`
}

export function AudioPlayer({ src, className }: { src: string; className?: string }) {
  const ref = useRef<HTMLAudioElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  const [speedIdx, setSpeedIdx] = useState(0)

  const toggle = () => {
    const a = ref.current
    if (!a) return
    if (a.paused) a.play().catch(() => {})
    else a.pause()
  }

  const seekTo = useCallback((clientX: number) => {
    const a = ref.current
    const bar = barRef.current
    if (!a || !bar || !dur) return
    const r = bar.getBoundingClientRect()
    const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    a.currentTime = pct * dur
    setCur(a.currentTime)
  }, [dur])

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

  const pct = dur ? (cur / dur) * 100 : 0

  return (
    <div className={cn('flex items-center gap-3 rounded-[var(--radius)] border bg-card px-3 py-2.5', className)}>
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
        className="group relative h-1.5 flex-1 cursor-pointer rounded-full bg-muted"
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(cur)}
      >
        <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${pct}%` }} />
        <div
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary opacity-0 shadow transition-opacity group-hover:opacity-100"
          style={{ left: `${pct}%` }}
        />
      </div>

      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{fmt(dur)}</span>

      <button
        type="button"
        onClick={cycleSpeed}
        className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground transition-colors hover:text-foreground"
        aria-label={`Playback speed ${SPEEDS[speedIdx]}x`}
      >
        {SPEEDS[speedIdx]}x
      </button>

      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
        onDurationChange={(e) => setDur(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </div>
  )
}
