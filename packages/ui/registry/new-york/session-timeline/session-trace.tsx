import { memo, useCallback, useMemo, useState } from 'react'
import { formatMs } from '@/lib/observability-format'
import type { SessionMetrics, TurnRecord } from '@/lib/observability-types'

// ─── Constants ────────────────────────────────────────────────────────────────

const SPAN_COLORS = {
  user: { bg: 'bg-muted', border: 'border-border', label: 'text-muted-foreground' },
  agent: { bg: 'bg-primary/20', border: 'border-primary/40', label: 'text-primary' },
  stt: { bg: 'bg-blue-500/20', border: 'border-blue-500/40', label: 'text-blue-600' },
  turn_decision: { bg: 'bg-slate-400/20', border: 'border-slate-400/40', label: 'text-slate-500' },
  llm: { bg: 'bg-violet-500/20', border: 'border-violet-500/40', label: 'text-violet-600' },
  tts: { bg: 'bg-teal-500/20', border: 'border-teal-500/40', label: 'text-teal-600' },
} as const

const ROW_HEIGHT = 28
const PIPELINE_ROW_HEIGHT = 22

// ─── Types ────────────────────────────────────────────────────────────────────

interface TimeSpan {
  startMs: number
  endMs: number
  turnIndex: number
  turnNumber: number
  text: string | null
}

interface PipelineSpan {
  kind: 'stt' | 'turn_decision' | 'llm' | 'tts'
  startMs: number
  endMs: number
  durationMs: number
}

interface ProcessedTurn {
  turnNumber: number
  turnIndex: number
  userSpan: TimeSpan | null
  agentSpan: TimeSpan | null
  pipelineSpans: PipelineSpan[]
  userText: string | null
  agentText: string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const parseMs = (iso: string | undefined): number | null => {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return isNaN(t) ? null : t
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

export const computeTickInterval = (totalMs: number): number => {
  if (totalMs <= 20_000) return 2000
  if (totalMs <= 60_000) return 5000
  if (totalMs <= 180_000) return 10_000
  return 30_000
}

// ─── Session bounds ───────────────────────────────────────────────────────────

export interface SessionBounds {
  sessionStartMs: number
  sessionEndMs: number
  totalMs: number
  tickInterval: number
}

export const computeSessionBounds = (metrics: SessionMetrics | null): SessionBounds => {
  const empty: SessionBounds = { sessionStartMs: 0, sessionEndMs: 0, totalMs: 0, tickInterval: 0 }
  if (!metrics?.turns?.length) return empty

  let sessionStartMs = Infinity
  let sessionEndMs = -Infinity

  for (const t of metrics.turns) {
    for (const iso of [
      t.user_started_speaking_at,
      t.user_stopped_speaking_at,
      t.agent_started_speaking_at,
      t.agent_stopped_speaking_at,
    ]) {
      const v = parseMs(iso)
      if (v != null) {
        if (v < sessionStartMs) sessionStartMs = v
        if (v > sessionEndMs) sessionEndMs = v
      }
    }

    const agentStart = parseMs(t.agent_started_speaking_at)
    if (agentStart != null) {
      const end =
        parseMs(t.agent_stopped_speaking_at) ?? agentStart + (t.tts_audio_duration_ms ?? 2000)
      if (end > sessionEndMs) sessionEndMs = end
    }
  }

  if (sessionStartMs === Infinity) return empty

  const durationMs = sessionEndMs - sessionStartMs
  const tickInterval = computeTickInterval(durationMs)
  const totalMs = Math.ceil(durationMs / 1000) * 1000 + tickInterval

  return { sessionStartMs, sessionEndMs, totalMs, tickInterval }
}

// ─── Pipeline span builder ───────────────────────────────────────────────────

const buildPipelineSpans = (
  t: TurnRecord,
  sessionStartMs: number,
  userStopRelMs: number | null,
  agentStartRelMs: number | null,
): PipelineSpan[] => {
  const spans: PipelineSpan[] = []
  const toRelMs = (unixSec: number) => unixSec * 1000 - sessionStartMs

  const hasRealTimestamps =
    t.stt_timestamp != null || t.llm_timestamp != null || t.tts_timestamp != null

  if (hasRealTimestamps) {
    if (t.stt_timestamp != null && t.stt_delay_ms && t.stt_delay_ms > 0) {
      const sttEnd = toRelMs(t.stt_timestamp)
      const sttStart = sttEnd - t.stt_delay_ms
      spans.push({ kind: 'stt', startMs: sttStart, endMs: sttEnd, durationMs: t.stt_delay_ms })
    }

    if (t.turn_decision_ms && t.turn_decision_ms > 0 && t.stt_timestamp != null) {
      const decStart = toRelMs(t.stt_timestamp)
      spans.push({
        kind: 'turn_decision',
        startMs: decStart,
        endMs: decStart + t.turn_decision_ms,
        durationMs: t.turn_decision_ms,
      })
    }

    if (t.llm_timestamp != null) {
      const llmStart = toRelMs(t.llm_timestamp)
      const llmDur = t.llm_duration_ms ?? t.llm_ttft_ms ?? 0
      if (llmDur > 0) {
        spans.push({ kind: 'llm', startMs: llmStart, endMs: llmStart + llmDur, durationMs: llmDur })
      }
    }

    if (t.tts_timestamp != null) {
      const ttsStart = toRelMs(t.tts_timestamp)
      const ttsDur = t.tts_audio_duration_ms ?? t.tts_ttfb_ms ?? 0
      if (ttsDur > 0) {
        spans.push({ kind: 'tts', startMs: ttsStart, endMs: ttsStart + ttsDur, durationMs: ttsDur })
      }
    }
  } else if (userStopRelMs != null) {
    const sttDur = t.stt_delay_ms
    const decisionDur = t.turn_decision_ms
    const llmDur = t.llm_duration_ms ?? t.llm_ttft_ms
    const ttsDur = t.tts_audio_duration_ms ?? t.tts_ttfb_ms

    if (sttDur != null && sttDur > 0) {
      const sttStart = userStopRelMs
      spans.push({ kind: 'stt', startMs: sttStart, endMs: sttStart + sttDur, durationMs: sttDur })

      let cursor = sttStart + sttDur

      if (decisionDur != null && decisionDur > 0) {
        spans.push({
          kind: 'turn_decision',
          startMs: cursor,
          endMs: cursor + decisionDur,
          durationMs: decisionDur,
        })
        cursor += decisionDur
      }

      if (llmDur != null && llmDur > 0) {
        spans.push({ kind: 'llm', startMs: cursor, endMs: cursor + llmDur, durationMs: llmDur })

        if (ttsDur != null && ttsDur > 0) {
          const ttsStart = cursor + (t.llm_ttft_ms ?? 0)
          spans.push({ kind: 'tts', startMs: ttsStart, endMs: ttsStart + ttsDur, durationMs: ttsDur })
        }
      }
    }
  }

  if (spans.length === 0 && t.agent_first && agentStartRelMs != null) {
    const ttsDur = t.tts_audio_duration_ms ?? t.tts_ttfb_ms
    if (ttsDur && ttsDur > 0) {
      spans.push({
        kind: 'tts',
        startMs: agentStartRelMs,
        endMs: agentStartRelMs + ttsDur,
        durationMs: ttsDur,
      })
    }
  }

  return spans
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

interface TooltipState {
  x: number
  y: number
  turnNumber: number
  label: string
  durationMs: number
  text: string | null
}

function TraceTooltip({ tip }: { tip: TooltipState }) {
  return (
    <div
      className="pointer-events-none fixed z-50 rounded-md border bg-background p-2.5 shadow-lg text-[11px] max-w-[260px]"
      style={{ left: tip.x + 12, top: tip.y - 8 }}
    >
      <div className="flex items-center justify-between gap-3 mb-1">
        <span className="font-medium text-foreground">
          Turn {tip.turnNumber} · {tip.label}
        </span>
        <span className="text-muted-foreground tabular-nums">{formatMs(tip.durationMs)}</span>
      </div>
      {tip.text && <p className="text-muted-foreground leading-snug line-clamp-3">{tip.text}</p>}
    </div>
  )
}

// ─── Span Block ───────────────────────────────────────────────────────────────

interface SpanBlockProps {
  left: number
  width: number
  colorClass: { bg: string; border: string; label: string }
  label?: string
  height?: number
  onMouseEnter: (e: React.MouseEvent) => void
  onMouseLeave: () => void
  onClick?: () => void
}

function SpanBlock({
  left,
  width,
  colorClass,
  label,
  height = ROW_HEIGHT,
  onMouseEnter,
  onMouseLeave,
  onClick,
}: SpanBlockProps) {
  return (
    <div
      className={[
        'absolute top-1/2 -translate-y-1/2 rounded border cursor-default select-none',
        colorClass.bg,
        colorClass.border,
        onClick ? 'cursor-pointer' : '',
      ].join(' ')}
      style={{ left: `${left * 100}%`, width: `max(3px, ${width * 100}%)`, height: height - 6 }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    >
      {label && width > 0.04 && (
        <span
          className={[
            'absolute inset-0 flex items-center px-1.5 text-[10px] font-medium truncate',
            colorClass.label,
          ].join(' ')}
        >
          {label}
        </span>
      )}
    </div>
  )
}

// ─── Time Axis ────────────────────────────────────────────────────────────────

export function TimeAxis({ totalMs, tickInterval }: { totalMs: number; tickInterval: number }) {
  const ticks: number[] = []
  for (let t = 0; t <= totalMs; t += tickInterval) ticks.push(t)
  if (ticks[ticks.length - 1] < totalMs) ticks.push(totalMs)

  return (
    <div className="relative h-6 mb-1">
      {ticks.map((t) => {
        const pct = totalMs > 0 ? (t / totalMs) * 100 : 0
        return (
          <div
            key={t}
            className="absolute flex flex-col items-center"
            style={{ left: `${pct}%`, transform: 'translateX(-50%)' }}
          >
            <span className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">
              {t === 0 ? '0s' : `${(t / 1000).toFixed(0)}s`}
            </span>
            <div className="w-px h-1.5 bg-border mt-0.5" />
          </div>
        )
      })}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-border" />
    </div>
  )
}

// ─── Grid Lines ───────────────────────────────────────────────────────────────

function GridLines({ totalMs, tickInterval }: { totalMs: number; tickInterval: number }) {
  const ticks: number[] = []
  for (let t = tickInterval; t < totalMs; t += tickInterval) ticks.push(t)

  return (
    <>
      {ticks.map((t) => (
        <div
          key={t}
          className="absolute inset-y-0 w-px bg-border/40"
          style={{ left: `${(t / totalMs) * 100}%` }}
        />
      ))}
    </>
  )
}

function TraceRow({ height = ROW_HEIGHT, children }: { height?: number; children: React.ReactNode }) {
  return (
    <div className="relative" style={{ height }}>
      {children}
    </div>
  )
}

// ─── Span row config ──────────────────────────────────────────────────────────

const SPAN_ROWS = [
  {
    key: 'user' as const,
    getSpan: (pt: ProcessedTurn) => pt.userSpan,
    colors: SPAN_COLORS.user,
    prefix: 'User',
    tooltip: 'User speech',
    getText: (pt: ProcessedTurn) => pt.userText,
    delay: 500,
    buffer: { before: 300, after: 300 },
  },
  {
    key: 'agent' as const,
    getSpan: (pt: ProcessedTurn) => pt.agentSpan,
    colors: SPAN_COLORS.agent,
    prefix: 'Agent',
    tooltip: 'Agent speech',
    getText: (pt: ProcessedTurn) => pt.agentText,
    delay: 1000,
    buffer: { before: 0, after: 500 },
  },
]

const pipelineLabelMap: Record<PipelineSpan['kind'], string> = {
  stt: 'STT',
  turn_decision: 'Decision',
  llm: 'LLM',
  tts: 'TTS',
}

const kindRows: Array<PipelineSpan['kind']> = ['stt', 'turn_decision', 'llm', 'tts']

// ─── Trace Content (memoized) ─────────────────────────────────────────────────

interface TraceContentProps {
  processedTurns: ProcessedTurn[]
  sortedExpandedTurns: number[]
  turnMap: Map<number, ProcessedTurn>
  totalMs: number
  tickInterval: number
  offsetMs: number
  currentTimeMs?: number
  onSeek?: (timeMs: number) => void
  onTurnClick?: (turnNumber: number) => void
  showTip: (e: React.MouseEvent, turnNumber: number, label: string, durationMs: number, text: string | null) => void
  hideTip: () => void
  toggleTurn: (turnNumber: number) => void
}

const TraceContent = memo(
  ({
    processedTurns,
    sortedExpandedTurns,
    turnMap,
    totalMs,
    tickInterval,
    offsetMs,
    currentTimeMs,
    onSeek,
    onTurnClick,
    showTip,
    hideTip,
    toggleTurn,
  }: TraceContentProps) => {
    const toFrac = (ms: number) => clamp((ms + offsetMs) / totalMs, 0, 1)
    const spanWidth = (start: number, end: number) => clamp(toFrac(end) - toFrac(start), 0, 1)

    const handleTraceClick = (e: React.MouseEvent<HTMLDivElement>) => {
      if (!onSeek) return
      const rect = e.currentTarget.getBoundingClientRect()
      const relX = e.clientX - rect.left
      const timeMs = clamp((relX / rect.width) * totalMs, 0, totalMs)
      onSeek(timeMs)
    }

    return (
      <div
        className="relative"
        onClick={onSeek ? handleTraceClick : undefined}
        style={{ cursor: onSeek ? 'crosshair' : undefined }}
      >
        {SPAN_ROWS.map(({ key, getSpan, colors, prefix, tooltip: tooltipLabel, getText, delay, buffer }) => (
          <TraceRow key={key}>
            <GridLines totalMs={totalMs} tickInterval={tickInterval} />
            {processedTurns.map((pt) => {
              const s = getSpan(pt)
              if (!s) return null
              const visStart = Math.max(0, s.startMs + delay - buffer.before)
              const visEnd = s.endMs + delay + buffer.after
              const left = toFrac(visStart)
              const width = spanWidth(visStart, visEnd)
              return (
                <SpanBlock
                  key={pt.turnNumber}
                  left={left}
                  width={width}
                  colorClass={colors}
                  label={`${prefix} T${s.turnNumber}`}
                  height={ROW_HEIGHT}
                  onMouseEnter={(e) => showTip(e, s.turnNumber, tooltipLabel, s.endMs - s.startMs, getText(pt))}
                  onMouseLeave={hideTip}
                  onClick={() => {
                    if (pt.pipelineSpans.length) toggleTurn(pt.turnNumber)
                    onTurnClick?.(pt.turnNumber)
                  }}
                />
              )
            })}
          </TraceRow>
        ))}

        {sortedExpandedTurns.map((turnNumber) => {
          const pt = turnMap.get(turnNumber)
          if (!pt || !pt.pipelineSpans.length) return null

          return kindRows.map((kind) => {
            const spans = pt.pipelineSpans.filter((s) => s.kind === kind)
            if (!spans.length) return null
            const colors = SPAN_COLORS[kind]

            return (
              <TraceRow key={`${pt.turnNumber}-${kind}`} height={PIPELINE_ROW_HEIGHT}>
                {spans.map((s, si) => {
                  const left = toFrac(s.startMs)
                  const width = spanWidth(s.startMs, s.endMs)
                  return (
                    <SpanBlock
                      key={si}
                      left={left}
                      width={width}
                      colorClass={colors}
                      label={`${pipelineLabelMap[kind]} ${formatMs(s.durationMs)}`}
                      height={PIPELINE_ROW_HEIGHT}
                      onMouseEnter={(e) => showTip(e, pt.turnNumber, pipelineLabelMap[kind], s.durationMs, null)}
                      onMouseLeave={hideTip}
                    />
                  )
                })}
              </TraceRow>
            )
          })
        })}

        {currentTimeMs != null && currentTimeMs > 0 && (
          <div
            className="absolute top-0 bottom-0 w-px bg-primary z-10 pointer-events-none"
            style={{ left: `${(currentTimeMs / totalMs) * 100}%` }}
          />
        )}
      </div>
    )
  },
)

TraceContent.displayName = 'TraceContent'

// ─── Main Component ───────────────────────────────────────────────────────────

interface SessionTraceProps {
  metrics: SessionMetrics | null
  currentTimeMs?: number
  onSeek?: (timeMs: number) => void
  onTurnClick?: (turnNumber: number) => void
  hideHeader?: boolean
  hideTimeAxis?: boolean
  embedded?: boolean
  sharedTotalMs?: number
  sharedTickInterval?: number
  sharedOffsetMs?: number
}

export function SessionTrace({
  metrics,
  currentTimeMs,
  onSeek,
  onTurnClick,
  hideHeader,
  hideTimeAxis,
  embedded,
  sharedTotalMs,
  sharedTickInterval,
  sharedOffsetMs,
}: SessionTraceProps) {
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set())
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)

  const { processedTurns, bounds } = useMemo(() => {
    const bounds = computeSessionBounds(metrics)
    if (!metrics?.turns?.length || bounds.totalMs === 0)
      return { processedTurns: [] as ProcessedTurn[], bounds }

    const { sessionStartMs } = bounds
    const processed: ProcessedTurn[] = []

    for (let i = 0; i < metrics.turns.length; i++) {
      const t = metrics.turns[i]
      const userStart = parseMs(t.user_started_speaking_at)
      const userStop = parseMs(t.user_stopped_speaking_at)
      const agentStart = parseMs(t.agent_started_speaking_at)
      const agentStop = parseMs(t.agent_stopped_speaking_at)

      let userSpan: TimeSpan | null = null
      if (userStart != null && userStop != null && userStop > userStart) {
        userSpan = {
          startMs: userStart - sessionStartMs,
          endMs: userStop - sessionStartMs,
          turnIndex: i,
          turnNumber: t.turn_number,
          text: t.user_text,
        }
      }

      let agentSpan: TimeSpan | null = null
      if (agentStart != null) {
        const agentEnd = agentStop ?? agentStart + (t.tts_audio_duration_ms ?? 2000)
        agentSpan = {
          startMs: agentStart - sessionStartMs,
          endMs: agentEnd - sessionStartMs,
          turnIndex: i,
          turnNumber: t.turn_number,
          text: t.agent_text,
        }
      }

      const userStopRel = userStop != null ? userStop - sessionStartMs : null
      const agentStartRel = agentStart != null ? agentStart - sessionStartMs : null
      const pipelineSpans = buildPipelineSpans(t, sessionStartMs, userStopRel, agentStartRel)

      processed.push({
        turnNumber: t.turn_number,
        turnIndex: i,
        userSpan,
        agentSpan,
        pipelineSpans,
        userText: t.user_text,
        agentText: t.agent_text,
      })
    }

    return { processedTurns: processed, bounds }
  }, [metrics])

  const totalMs = sharedTotalMs ?? bounds.totalMs
  const tickInterval = sharedTickInterval ?? bounds.tickInterval
  const offsetMs = sharedOffsetMs ?? 0

  const turnMap = useMemo(() => {
    const map = new Map<number, ProcessedTurn>()
    for (const pt of processedTurns) map.set(pt.turnNumber, pt)
    return map
  }, [processedTurns])

  const sortedExpandedTurns = useMemo(
    () => [...expandedTurns].sort((a, b) => a - b),
    [expandedTurns],
  )

  const toggleTurn = useCallback((turnNumber: number) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev)
      if (next.has(turnNumber)) next.delete(turnNumber)
      else next.add(turnNumber)
      return next
    })
  }, [])

  const showTip = useCallback(
    (e: React.MouseEvent, turnNumber: number, label: string, durationMs: number, text: string | null) => {
      setTooltip({ x: e.clientX, y: e.clientY, turnNumber, label, durationMs, text })
    },
    [],
  )

  const hideTip = useCallback(() => setTooltip(null), [])

  if (!processedTurns.length) return null

  return (
    <div className={embedded ? '' : 'rounded-lg border p-5'}>
      {!hideHeader && (
        <div className="mb-3">
          <span className="text-[14px] font-medium">Session Trace</span>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            Turn-by-turn trace · click a turn to expand pipeline
          </p>
        </div>
      )}

      {!hideTimeAxis && totalMs > 0 && <TimeAxis totalMs={totalMs} tickInterval={tickInterval} />}

      <TraceContent
        processedTurns={processedTurns}
        sortedExpandedTurns={sortedExpandedTurns}
        turnMap={turnMap}
        totalMs={totalMs}
        tickInterval={tickInterval}
        offsetMs={offsetMs}
        currentTimeMs={currentTimeMs}
        onSeek={onSeek}
        onTurnClick={onTurnClick}
        showTip={showTip}
        hideTip={hideTip}
        toggleTurn={toggleTurn}
      />

      {tooltip && <TraceTooltip tip={tooltip} />}
    </div>
  )
}
