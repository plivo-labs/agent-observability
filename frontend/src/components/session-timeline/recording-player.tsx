import { Loader2, Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import WaveSurfer from 'wavesurfer.js'

/* ─── WaveSurfer runtime helper ───────────────────────────────
 * wavesurfer.js v7 inherits play/pause/isPlaying/setTime from
 * its Player base class, but the published types are incomplete
 * under skipLibCheck. We cast through `any` at call-sites via
 * this thin wrapper so the rest of the code stays type-safe.
 * ─────────────────────────────────────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WS = any

function toWS(instance: WaveSurfer): WS {
  return instance as WS
}

/* ─── Static config ──────────────────────────────────────── */

export const RECORDING_LABEL_WIDTH = 72

interface RecordingPlayerProps {
  recordUrl: string | null | undefined
  embedded?: boolean
  labelWidth?: number
  onTimeUpdate?: (currentTimeMs: number) => void
  onReady?: (durationMs: number) => void
  onSeek?: (timeMs: number) => void
  currentTimeMs?: number
  controlsContainer?: HTMLElement | null
  timelineDurationMs?: number
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

const SPEEDS = [1, 1.5, 2] as const
type Speed = (typeof SPEEDS)[number]

const USER_WAVE_COLOR = 'hsl(var(--tertiary))'
const USER_PROGRESS_COLOR = 'hsl(var(--secondary))'
const AGENT_WAVE_COLOR = 'hsl(var(--accent-purple) / 0.7)'
const AGENT_PROGRESS_COLOR = 'hsl(var(--accent-purple))'
const CURSOR_COLOR = 'hsl(var(--primary))'

const SHARED_WS_OPTIONS = {
  height: 36,
  barWidth: 2,
  barGap: 1,
  barRadius: 2,
  cursorColor: CURSOR_COLOR,
  cursorWidth: 0,
  normalize: true,
  interact: true,
  dragToSeek: true,
} as const

/* ─── Helpers ────────────────────────────────────────────── */

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

/* ─── Channel label + waveform row ──────────────────────── */

function ChannelRow({
  label,
  containerRef,
  labelColor,
  labelWidth,
  waveformWidthPct,
}: {
  label: string
  containerRef: React.RefObject<HTMLDivElement | null>
  labelColor: string
  labelWidth: number
  waveformWidthPct?: string
}) {
  return (
    <div className="flex items-center">
      <span
        className="text-[12px] shrink-0 text-right pr-2"
        style={{ color: labelColor, width: labelWidth }}
      >
        {label}
      </span>
      <div className="flex-1 min-w-0">
        <div ref={containerRef} style={waveformWidthPct ? { width: waveformWidthPct } : undefined} />
      </div>
    </div>
  )
}

/* ─── RecordingPlayer ────────────────────────────────────── */

export function RecordingPlayer({
  recordUrl,
  embedded = false,
  labelWidth = RECORDING_LABEL_WIDTH,
  onTimeUpdate,
  onReady,
  onSeek,
  currentTimeMs,
  controlsContainer,
  timelineDurationMs,
}: RecordingPlayerProps) {
  const userContainerRef = useRef<HTMLDivElement>(null)
  const agentContainerRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const userWsRef = useRef<WS | null>(null)
  const agentWsRef = useRef<WS | null>(null)
  const durationRef = useRef<number>(0)
  const isInternalSeekRef = useRef(false)
  const agentClickCleanupRef = useRef<(() => void) | null>(null)

  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [speed, setSpeed] = useState<Speed>(1)

  useEffect(() => {
    if (!recordUrl) return
    if (!userContainerRef.current || !agentContainerRef.current) return

    let cancelled = false
    setLoadState('loading')
    setCurrentTime(0)
    setDuration(0)
    setIsPlaying(false)

    const run = async () => {
      try {
        const response = await fetch(recordUrl)
        if (cancelled) return
        const arrayBuffer = await response.arrayBuffer()
        if (cancelled) return

        const audioCtx = new AudioContext()
        const stereoBuffer = await audioCtx.decodeAudioData(arrayBuffer)
        await audioCtx.close()
        if (cancelled) return

        const { numberOfChannels } = stereoBuffer
        const leftChannelData = stereoBuffer.getChannelData(0)
        const rightChannelData = stereoBuffer.getChannelData(Math.min(1, numberOfChannels - 1))
        const audioDuration = stereoBuffer.duration

        const audio = new Audio()
        audio.crossOrigin = 'anonymous'
        audio.src = recordUrl
        audio.preload = 'auto'
        audioRef.current = audio

        const userWs = toWS(
          WaveSurfer.create({
            container: userContainerRef.current as HTMLDivElement,
            waveColor: USER_WAVE_COLOR,
            progressColor: USER_PROGRESS_COLOR,
            ...SHARED_WS_OPTIONS,
            ...({
              media: audio,
              peaks: [leftChannelData],
              duration: audioDuration,
            } as Record<string, unknown>),
          }),
        )

        const agentWs = toWS(
          WaveSurfer.create({
            container: agentContainerRef.current as HTMLDivElement,
            waveColor: AGENT_WAVE_COLOR,
            progressColor: AGENT_PROGRESS_COLOR,
            ...SHARED_WS_OPTIONS,
            ...({
              peaks: [rightChannelData],
              duration: audioDuration,
              interact: false,
            } as Record<string, unknown>),
          }),
        )

        userWsRef.current = userWs
        agentWsRef.current = agentWs
        durationRef.current = audioDuration

        userWs.on('audioprocess', () => {
          const t = userWs.getCurrentTime()
          setCurrentTime(t)
          agentWs.seekTo(t / audioDuration)
          isInternalSeekRef.current = true
          onTimeUpdate?.(t * 1000)
          isInternalSeekRef.current = false
        })
        userWs.on('seeking', () => {
          const t = userWs.getCurrentTime()
          setCurrentTime(t)
          agentWs.seekTo(t / audioDuration)
          isInternalSeekRef.current = true
          onTimeUpdate?.(t * 1000)
          onSeek?.(t * 1000)
          isInternalSeekRef.current = false
        })
        userWs.on('play', () => setIsPlaying(true))
        userWs.on('pause', () => setIsPlaying(false))
        userWs.on('finish', () => {
          setIsPlaying(false)
          setCurrentTime(0)
        })

        const agentEl = agentContainerRef.current
        const handleAgentClick = (e: MouseEvent) => {
          const rect = agentEl?.getBoundingClientRect()
          if (!rect) return
          const progress = (e.clientX - rect.left) / rect.width
          userWs.seekTo(progress)
        }
        agentEl?.addEventListener('click', handleAgentClick)
        agentClickCleanupRef.current = () => agentEl?.removeEventListener('click', handleAgentClick)

        setDuration(audioDuration)
        setLoadState('ready')
        onReady?.(audioDuration * 1000)

        audio.volume = isMuted ? 0 : volume
        audio.playbackRate = speed
      } catch {
        if (!cancelled) setLoadState('error')
      }
    }

    run()

    return () => {
      cancelled = true
      agentClickCleanupRef.current?.()
      agentClickCleanupRef.current = null
      userWsRef.current?.destroy()
      agentWsRef.current?.destroy()
      userWsRef.current = null
      agentWsRef.current = null
      durationRef.current = 0
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.src = ''
        audioRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordUrl])

  useEffect(() => {
    if (currentTimeMs === undefined) return
    if (isInternalSeekRef.current) return
    const userWs = userWsRef.current
    const dur = durationRef.current
    if (!userWs || dur <= 0) return
    userWs.seekTo(currentTimeMs / (dur * 1000))
  }, [currentTimeMs])

  useEffect(() => {
    if (!audioRef.current || loadState !== 'ready') return
    audioRef.current.volume = isMuted ? 0 : volume
  }, [volume, isMuted, loadState])

  useEffect(() => {
    if (!audioRef.current || loadState !== 'ready') return
    audioRef.current.playbackRate = speed
  }, [speed, loadState])

  const handlePlayPause = () => {
    const player = userWsRef.current
    if (!player) return
    if (isPlaying) {
      player.pause()
    } else {
      player.play().catch(() => undefined)
    }
  }

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value)
    setVolume(v)
    setIsMuted(v === 0)
  }

  const handleMuteToggle = () => setIsMuted((prev) => !prev)

  const cycleSpeed = () => {
    setSpeed((prev) => {
      const idx = SPEEDS.indexOf(prev)
      return SPEEDS[(idx + 1) % SPEEDS.length]
    })
  }

  if (!recordUrl) {
    if (embedded) return null
    return (
      <div className="rounded-lg border bg-card p-4">
        <p className="text-[12px] text-muted-foreground">No recording available</p>
      </div>
    )
  }

  const waveformWidthPct =
    timelineDurationMs && timelineDurationMs > 0 && duration > 0
      ? `${((duration * 1000) / timelineDurationMs) * 100}%`
      : undefined

  const waveformArea = (
    <div className="flex flex-col gap-2 relative">
      {loadState === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-card/80 z-10 rounded">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {loadState === 'error' && (
        <div className="flex items-center justify-center py-8">
          <p className="text-[12px] text-muted-foreground">Failed to load recording</p>
        </div>
      )}
      <ChannelRow
        label="User"
        containerRef={userContainerRef}
        labelColor={USER_WAVE_COLOR}
        labelWidth={labelWidth}
        waveformWidthPct={waveformWidthPct}
      />
      <ChannelRow
        label="Agent"
        containerRef={agentContainerRef}
        labelColor={AGENT_WAVE_COLOR}
        labelWidth={labelWidth}
        waveformWidthPct={waveformWidthPct}
      />
    </div>
  )

  const controlsArea = (
    <div
      className="flex items-center gap-3"
      style={!controlsContainer && embedded ? { paddingLeft: labelWidth } : undefined}
    >
      <button
        onClick={handlePlayPause}
        disabled={loadState !== 'ready'}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      </button>

      <span className="text-[12px] text-muted-foreground tabular-nums">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>

      <div className="flex items-center gap-1.5 ml-auto">
        <button
          onClick={handleMuteToggle}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          aria-label={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted || volume === 0 ? (
            <VolumeX className="h-4 w-4" />
          ) : (
            <Volume2 className="h-4 w-4" />
          )}
        </button>

        <input
          type="range"
          min={0}
          max={1}
          step={0.02}
          value={isMuted ? 0 : volume}
          onChange={handleVolumeChange}
          className="w-16 h-1 accent-primary cursor-pointer"
          aria-label="Volume"
        />

        <button
          onClick={cycleSpeed}
          className="ml-1 w-8 text-center text-[12px] text-muted-foreground hover:text-foreground transition-colors tabular-nums"
          aria-label={`Playback speed ${speed}x`}
        >
          {speed}x
        </button>
      </div>
    </div>
  )

  if (embedded) {
    return (
      <>
        {controlsContainer && createPortal(controlsArea, controlsContainer)}
        <div className="flex flex-col gap-3">
          {!controlsContainer && controlsArea}
          {waveformArea}
        </div>
      </>
    )
  }

  return (
    <>
      {controlsContainer && createPortal(controlsArea, controlsContainer)}
      <div className="rounded-lg border bg-card p-4 flex flex-col gap-3">
        {!controlsContainer && controlsArea}
        {waveformArea}
      </div>
    </>
  )
}
