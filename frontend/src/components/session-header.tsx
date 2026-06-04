import { ClipboardCheck, Download, Hash, Radio } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatDate, formatDuration } from '@/lib/observability-format'
import type { AgentSessionRow } from '@/lib/observability-types'
import { useSession } from '@/lib/observability-hooks'
import { CapsChips } from '@/components/obs-cells'

const PRIMARY_FG = { color: 'hsl(var(--primary-foreground))' }

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[hsl(var(--tertiary))]">
        {label}
      </span>
      <span className="min-w-0 text-sm text-foreground">{children}</span>
    </div>
  )
}

interface SessionHeaderProps {
  session?: AgentSessionRow
  onEvaluationsClick?: () => void
}

function isTextOnlySession(session: AgentSessionRow): boolean {
  const transport = String(session.transport ?? '')
  return transport === 'text' ||
    transport === 'terminal_text' ||
    Boolean(session.tags?.some((tag) => tag.name === 'transport:text' || tag.name === 'transport:terminal_text'))
}

export const SessionHeader = ({
  session: sessionProp,
  onEvaluationsClick,
}: SessionHeaderProps) => {
  const { session: hookSession } = useSession()
  const session = sessionProp ?? hookSession
  if (!session) return null

  const isLive = session.state !== 'ended'
  const stateLabel = session.state
    ? session.state.charAt(0).toUpperCase() + session.state.slice(1)
    : 'Unknown'
  const evaluationCount = session.evaluations?.length ?? 0
  // `evaluations:enabled` is emitted by the Python adapter when judges are
  // configured (or by callers passing `metadata.evaluations=true`). Surfacing
  // the button on that signal lets users see "evaluations are coming" before
  // judge results land. Node sessions never carry this tag.
  const hasEvaluationFlag = session.tags?.some((tag) => tag.name === 'evaluations:enabled') ?? false
  const hasEvaluationData = evaluationCount > 0 || session.outcome != null || hasEvaluationFlag
  const textOnly = isTextOnlySession(session)

  return (
    <header className="ao-hero ao-reveal">
      <div className="min-w-0">
        <div className="ao-hero-eyebrow">
          <Radio /> Session
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="ao-hero-title flex items-center gap-2 break-all font-mono !text-[22px] tracking-tight">
            <Hash size={18} className="shrink-0 text-[hsl(var(--tertiary))]" />
            {session.session_id}
          </h1>
          <span className={`ao-badge ao-badge--dot ${isLive ? 'is-success is-pulse' : 'is-neutral'}`}>
            {stateLabel}
          </span>
        </div>

        <div className="mt-5 flex flex-wrap items-start gap-x-10 gap-y-4">
          <MetaItem label="Capabilities">
            <CapsChips
              stt={!textOnly && session.has_stt}
              llm={session.has_llm}
              tts={!textOnly && session.has_tts}
            />
          </MetaItem>
          <MetaItem label="Turns">
            <span className="font-mono tabular-nums">{session.turn_count ?? '—'}</span>
          </MetaItem>
          <MetaItem label="Started">{formatDate(session.started_at)}</MetaItem>
          <MetaItem label="Ended">{formatDate(session.ended_at)}</MetaItem>
          <MetaItem label="Recording">
            {session.record_url ? (
              <a
                className="inline-flex items-center gap-1.5 text-[hsl(var(--link))] hover:underline"
                href={session.record_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Download size={13} /> Download
              </a>
            ) : (
              <span className="text-[hsl(var(--tertiary))]">—</span>
            )}
          </MetaItem>
        </div>
      </div>

      <div className="ao-hero-actions flex-col items-end">
        <div className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-foreground">
          {formatDuration(session.duration_ms)}
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[hsl(var(--tertiary))]">
          Duration
        </span>
        {onEvaluationsClick && hasEvaluationData && (
          <Button
            variant="default"
            size="sm"
            className="mt-2"
            style={PRIMARY_FG}
            onClick={onEvaluationsClick}
          >
            <ClipboardCheck size={13} />
            Evaluation
            {evaluationCount > 0 && <span>({evaluationCount})</span>}
          </Button>
        )}
      </div>
    </header>
  )
}
