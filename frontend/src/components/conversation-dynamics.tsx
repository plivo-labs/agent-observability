import { useMemo } from 'react'
import {
  formatDuration,
  formatMs,
  formatPercent,
  perceivedLatencyTone,
  valueToneClass,
} from '@/lib/observability-format'
import type { SessionMetrics, TurnRecord } from '@/lib/observability-types'
import { usePerformance } from '@/lib/observability-hooks'
import { ChartLegendItem } from '@/components/observability-chart-shared'

// Lane hues match the registry's talk-time-chart so user/agent colors stay
// consistent anywhere both components render.
const USER_COLOR = 'var(--info)'
const AGENT_COLOR = 'var(--success)'

// Silence-share severity. Practitioner data (Canonical AI) links >30%
// silence to early hang-ups; tone at 50/70 to flag only clear problems.
const SILENCE_WARN = 0.5
const SILENCE_BAD = 0.7

const parseTs = (iso?: string): number | undefined => {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : t
}

interface SpeechBlock {
  key: string
  leftPct: number
  widthPct: number
  title: string
  interrupted?: boolean
}

interface RhythmStrip {
  user: SpeechBlock[]
  agent: SpeechBlock[]
  gaps: Array<{ key: string; leftPct: number; widthPct: number; title: string }>
  spanMs: number
}

/** Lay the session's speech out on a normalized 0–100% timeline. Returns
 * null when fewer than two turns carry timestamps — a strip with one block
 * reads as noise, the stat cluster below carries the signal instead. */
function buildStrip(turns: TurnRecord[], deadAirThresholdMs: number): RhythmStrip | null {
  const spans = turns.map((turn) => ({
    turn,
    userStart: parseTs(turn.user_started_speaking_at),
    userStop: parseTs(turn.user_stopped_speaking_at),
    agentStart: parseTs(turn.agent_started_speaking_at),
    agentStop: parseTs(turn.agent_stopped_speaking_at),
  }))

  let origin = Infinity
  let end = -Infinity
  let timestamped = 0
  for (const s of spans) {
    if (s.userStart != null || s.agentStart != null) timestamped++
    for (const v of [s.userStart, s.userStop, s.agentStart, s.agentStop]) {
      if (v != null) {
        origin = Math.min(origin, v)
        end = Math.max(end, v)
      }
    }
  }
  const spanMs = end - origin
  if (timestamped < 2 || spanMs <= 0) return null

  const pct = (ms: number) => (ms / spanMs) * 100
  // Floor width keeps sub-pixel utterances visible on long sessions.
  const widthPct = (from: number, to: number) => Math.max(0.4, pct(to - from))

  const user: SpeechBlock[] = []
  const agent: SpeechBlock[] = []
  const gaps: RhythmStrip['gaps'] = []
  let prevAgentStop: number | undefined

  for (const s of spans) {
    const n = s.turn.turn_number
    if (s.userStart != null && s.userStop != null && s.userStop > s.userStart) {
      user.push({
        key: `u-${n}`,
        leftPct: pct(s.userStart - origin),
        widthPct: widthPct(s.userStart, s.userStop),
        title: `Turn ${n} — user spoke ${formatMs(s.userStop - s.userStart)}`,
      })
    }
    if (s.agentStart != null && s.agentStop != null && s.agentStop > s.agentStart) {
      agent.push({
        key: `a-${n}`,
        leftPct: pct(s.agentStart - origin),
        widthPct: widthPct(s.agentStart, s.agentStop),
        title: `Turn ${n} — agent spoke ${formatMs(s.agentStop - s.agentStart)}${s.turn.interrupted ? ' (interrupted)' : ''}`,
        interrupted: s.turn.interrupted,
      })
    }
    const gapMs = s.turn.inter_turn_gap_ms
    if (
      gapMs != null &&
      gapMs >= deadAirThresholdMs &&
      prevAgentStop != null &&
      s.userStart != null &&
      s.userStart > prevAgentStop
    ) {
      gaps.push({
        key: `g-${n}`,
        leftPct: pct(prevAgentStop - origin),
        widthPct: widthPct(prevAgentStop, s.userStart),
        title: `${formatMs(gapMs)} of silence before turn ${n}`,
      })
    }
    if (s.agentStop != null) prevAgentStop = s.agentStop
  }

  return { user, agent, gaps, spanMs }
}

const StatLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
    {children}
  </div>
)

const StatRow = ({
  label,
  value,
  toneClass,
}: {
  label: string
  value: React.ReactNode
  toneClass?: string
}) => (
  <div className="flex justify-between text-s-400">
    <span className="text-muted-foreground">{label}</span>
    <span className={`font-mono tabular-nums ${toneClass ?? ''}`}>{value}</span>
  </div>
)

export const ConversationDynamics = ({
  metrics: metricsProp,
}: {
  metrics?: SessionMetrics | null
}) => {
  const { metrics: hookMetrics } = usePerformance()
  const metrics = metricsProp ?? hookMetrics
  const voice = metrics?.summary?.voice

  const strip = useMemo(() => {
    if (!metrics?.turns?.length || !voice) return null
    return buildStrip(metrics.turns, voice.dead_air?.threshold_ms ?? 3000)
  }, [metrics, voice])

  // Voice block absent means a text-only session — render nothing so the
  // Performance tab looks exactly as it did before this panel existed.
  if (!voice) return null

  const talkRatio = voice.talk_ratio
  const agentPct = talkRatio != null ? Math.round(talkRatio * 100) : null
  const p95Tone = perceivedLatencyTone(voice.ttfa?.p95 ?? null)
  const silencePct = voice.silence_pct
  const silenceTone =
    silencePct == null
      ? undefined
      : silencePct >= SILENCE_BAD
        ? valueToneClass.bad
        : silencePct >= SILENCE_WARN
          ? valueToneClass.warn
          : undefined

  return (
    <div className="rounded-lg border bg-card p-5">
      <span className="text-p-400 font-medium">Conversation Dynamics</span>
      <p className="text-xs text-muted-foreground mt-0.5">
        Who spoke when — pacing, silence, and interruptions
      </p>

      {strip && (
        <div className="mt-4">
          <div className="relative h-[72px]">
            <div className="absolute left-0 right-0 top-1/2 h-px bg-border" />
            {strip.gaps.map((g) => (
              <div
                key={g.key}
                title={g.title}
                className="absolute top-1/2 -translate-y-1/2 border-t-2 border-dotted border-warning"
                style={{ left: `${g.leftPct}%`, width: `${g.widthPct}%` }}
              />
            ))}
            {strip.user.map((b) => (
              <div
                key={b.key}
                title={b.title}
                className="absolute top-[8px] h-[22px] rounded-sm opacity-90 transition-opacity hover:opacity-100"
                style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%`, background: USER_COLOR }}
              />
            ))}
            {strip.agent.map((b) => (
              <div
                key={b.key}
                title={b.title}
                className="absolute bottom-[8px] h-[22px] rounded-sm opacity-90 transition-opacity hover:opacity-100"
                style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%`, background: AGENT_COLOR }}
              >
                {b.interrupted && (
                  <span className="absolute inset-y-0 right-0 w-[3px] rounded-r-sm bg-destructive" />
                )}
              </div>
            ))}
          </div>
          <div className="flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
            <span>0:00</span>
            <span>{formatDuration(strip.spanMs / 2)}</span>
            <span>{formatDuration(strip.spanMs)}</span>
          </div>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        {(voice.user_speech_ms != null || voice.agent_speech_ms != null) && (
          <div>
            <StatLabel>Talk ratio</StatLabel>
            {agentPct != null && (
              <div className="mb-1.5 flex h-1.5 overflow-hidden rounded-full">
                <div style={{ width: `${agentPct}%`, background: AGENT_COLOR }} />
                <div style={{ width: `${100 - agentPct}%`, background: USER_COLOR }} />
              </div>
            )}
            {talkRatio != null && (
              <StatRow
                label="Agent · User"
                value={`${formatPercent(talkRatio)} · ${formatPercent(1 - talkRatio)}`}
              />
            )}
            <StatRow
              label="Speaking time"
              value={`${formatDuration(voice.agent_speech_ms ?? 0)} · ${formatDuration(voice.user_speech_ms ?? 0)}`}
            />
          </div>
        )}

        {(voice.ttfa != null || voice.greeting_ttfa_ms != null) && (
          <div>
            <StatLabel>Response time (TTFA)</StatLabel>
            {voice.ttfa && (
              <>
                <StatRow label="p50" value={formatMs(voice.ttfa.p50)} />
                <StatRow label="p90" value={formatMs(voice.ttfa.p90)} />
                <StatRow
                  label="p95"
                  value={formatMs(voice.ttfa.p95)}
                  toneClass={p95Tone ? valueToneClass[p95Tone] : undefined}
                />
              </>
            )}
            {voice.greeting_ttfa_ms != null && (
              <StatRow label="First greeting" value={formatMs(voice.greeting_ttfa_ms)} />
            )}
          </div>
        )}

        {voice.dead_air && (
          <div>
            <StatLabel>Dead air</StatLabel>
            <StatRow label="Events (≥3s)" value={voice.dead_air.count} />
            {voice.dead_air.count > 0 && (
              <>
                <StatRow label="Total" value={formatDuration(voice.dead_air.total_ms)} />
                <StatRow label="Longest" value={formatMs(voice.dead_air.max_ms)} />
              </>
            )}
            {silencePct != null && (
              <StatRow
                label="Silence share"
                value={`${formatPercent(silencePct)} of session`}
                toneClass={silenceTone}
              />
            )}
          </div>
        )}

        {(voice.longest_monologue_ms != null ||
          voice.agent_wpm != null ||
          voice.user_wpm != null) && (
          <div>
            <StatLabel>Pace</StatLabel>
            {voice.longest_monologue_ms != null && (
              <StatRow
                label="Longest monologue"
                value={`${formatDuration(voice.longest_monologue_ms)}${voice.longest_monologue_turn != null ? ` · turn ${voice.longest_monologue_turn}` : ''}`}
              />
            )}
            {voice.agent_wpm != null && <StatRow label="Agent pace" value={`${voice.agent_wpm} wpm`} />}
            {voice.user_wpm != null && <StatRow label="User pace" value={`${voice.user_wpm} wpm`} />}
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
        <ChartLegendItem color={USER_COLOR} label="User" />
        <ChartLegendItem color={AGENT_COLOR} label="Agent" />
        {strip && strip.gaps.length > 0 && (
          <ChartLegendItem color="var(--warning)" label="Dead air" />
        )}
      </div>
    </div>
  )
}
