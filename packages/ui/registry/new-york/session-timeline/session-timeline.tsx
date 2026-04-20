import { useCallback, useMemo, useRef, useState } from 'react'
import type { SessionMetrics } from '@/lib/observability-types'
import { useTimeline } from '@/lib/observability-hooks'
import { RECORDING_LABEL_WIDTH, RecordingPlayer } from './recording-player'
import { computeSessionBounds, computeTickInterval, SessionTrace, TimeAxis } from './session-trace'

interface SessionTimelineProps {
  metrics?: SessionMetrics | null
  recordUrl?: string | null | undefined
  onTurnClick?: (turnNumber: number) => void
  sessionCreatedAt?: string
}

export function SessionTimeline({
  metrics: metricsProp,
  recordUrl: recordUrlProp,
  onTurnClick: onTurnClickProp,
  sessionCreatedAt: sessionCreatedAtProp,
}: SessionTimelineProps) {
  const hook = useTimeline()
  const metrics = metricsProp ?? hook.metrics
  const recordUrl = recordUrlProp ?? hook.recordUrl
  const sessionCreatedAt = sessionCreatedAtProp ?? hook.sessionCreatedAt
  const onTurnClick = onTurnClickProp ?? hook.setHighlightedTurn

  const [audioDurationMs, setAudioDurationMs] = useState(0)
  const [currentTimeMs, setCurrentTimeMs] = useState(0)
  const cursorRef = useRef<HTMLDivElement>(null)
  const [controlsEl, setControlsEl] = useState<HTMLDivElement | null>(null)

  const traceBounds = useMemo(() => computeSessionBounds(metrics), [metrics])
  const totalMs = audioDurationMs > 0 ? audioDurationMs : traceBounds.totalMs
  const totalMsRef = useRef(totalMs)
  totalMsRef.current = totalMs

  const recordingOffsetMs = useMemo(() => {
    if (!sessionCreatedAt || !recordUrl || traceBounds.sessionStartMs === 0) return 0
    const createdMs = new Date(sessionCreatedAt).getTime()
    if (Number.isNaN(createdMs) || createdMs <= 0) return 0
    return Math.max(0, traceBounds.sessionStartMs - createdMs)
  }, [sessionCreatedAt, recordUrl, traceBounds.sessionStartMs])
  const tickInterval = computeTickInterval(totalMs)

  const handleTimeUpdate = useCallback((timeMs: number) => {
    setCurrentTimeMs(timeMs)
    const total = totalMsRef.current
    if (cursorRef.current && total > 0) {
      cursorRef.current.style.left = `${(timeMs / total) * 100}%`
    }
  }, [])

  const handleReady = useCallback((durationMs: number) => {
    setAudioDurationMs(durationMs)
  }, [])

  const handleSeek = useCallback((timeMs: number) => {
    setCurrentTimeMs(timeMs)
  }, [])

  const hasRecording = !!recordUrl
  const hasTrace = traceBounds.totalMs > 0

  if (!hasTrace && !hasRecording) {
    return (
      <div className="flex items-center justify-center h-20 text-[13px] text-muted-foreground">
        No trace data available
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div>
          <span className="text-[14px] font-medium">Session Timeline</span>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            Turn-by-turn trace · click a turn to expand pipeline
          </p>
        </div>
        {hasRecording && <div ref={setControlsEl} />}
      </div>

      <div className="mt-4">
        <div className="relative">
          {hasRecording && (
            <RecordingPlayer
              recordUrl={recordUrl}
              embedded
              labelWidth={RECORDING_LABEL_WIDTH}
              onTimeUpdate={handleTimeUpdate}
              onReady={handleReady}
              onSeek={handleSeek}
              controlsContainer={controlsEl}
            />
          )}
          <div style={hasRecording ? { paddingLeft: RECORDING_LABEL_WIDTH } : undefined}>
            {totalMs > 0 && <TimeAxis totalMs={totalMs} tickInterval={tickInterval} />}
          </div>

          {hasTrace && (
            <div style={hasRecording ? { paddingLeft: RECORDING_LABEL_WIDTH } : undefined}>
              <SessionTrace
                metrics={metrics}
                onSeek={hasRecording ? handleSeek : undefined}
                onTurnClick={onTurnClick}
                hideHeader
                hideTimeAxis
                embedded
                sharedTotalMs={totalMs}
                sharedTickInterval={tickInterval}
                sharedOffsetMs={recordingOffsetMs}
              />
            </div>
          )}

          {hasRecording && (
            <div
              className="absolute top-0 bottom-0 pointer-events-none z-10"
              style={{ left: RECORDING_LABEL_WIDTH, right: 0 }}
            >
              <div
                ref={cursorRef}
                className="absolute top-0 bottom-0 w-px bg-secondary"
                style={{ left: `${totalMs > 0 ? (currentTimeMs / totalMs) * 100 : 0}%` }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
