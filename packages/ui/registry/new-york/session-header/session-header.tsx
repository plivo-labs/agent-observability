import { ClipboardCheck, Download, Radio } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatDate, formatDuration } from '@/lib/observability-format'
import type { AgentSessionRow } from '@/lib/observability-types'
import { useSession } from '@/lib/observability-hooks'
import { CapsChips } from '@/components/obs-cells'

function KVRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <div className="k">{label}</div>
      <div className="v">{children}</div>
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

  const stateClass = session.state === 'ended' ? 'status-ended' : 'status-live'
  const evaluationCount = session.evaluations?.length ?? 0
  // `evaluations:enabled` is emitted by the Python adapter when judges are
  // configured (or by callers passing `metadata.evaluations=true`). Surfacing
  // the button on that signal lets users see "evaluations are coming" before
  // judge results land. Node sessions never carry this tag.
  const hasEvaluationFlag = session.tags?.some((tag) => tag.name === 'evaluations:enabled') ?? false
  const hasEvaluationData = evaluationCount > 0 || session.outcome != null || hasEvaluationFlag
  const textOnly = isTextOnlySession(session)

  return (
    <div className="obs-session-head">
      <div className="top">
        <div className="label">
          <Radio size={18} /> Session
          <span className={`status-pill ${stateClass}`}>
            <span className="dot" />
            {session.state ? session.state.charAt(0).toUpperCase() + session.state.slice(1) : 'Unknown'}
          </span>
        </div>
        <div className="session-actions">
          {onEvaluationsClick && hasEvaluationData && (
            <Button variant="outline" size="sm" onClick={onEvaluationsClick}>
              <ClipboardCheck size={13} />
              Evaluation
              {evaluationCount > 0 && <span>({evaluationCount})</span>}
            </Button>
          )}
          <div className="dur">{formatDuration(session.duration_ms)}</div>
        </div>
      </div>

      <div className="obs-kv">
        <KVRow label="Session ID">
          <span>{session.session_id}</span>
        </KVRow>
        <KVRow label="Agent">
          {session.agent_id || session.agent_name ? (
            <div className="flex flex-col items-end leading-tight">
              <span>{session.agent_name || session.agent_id}</span>
              {session.agent_name && session.agent_id && (
                <span className="text-muted-foreground text-[11px] font-mono">
                  {session.agent_id}
                </span>
              )}
            </div>
          ) : (
            <span style={{ color: 'hsl(var(--tertiary))' }}>—</span>
          )}
        </KVRow>
        <KVRow label="Capabilities">
          <CapsChips
            stt={!textOnly && session.has_stt}
            llm={session.has_llm}
            tts={!textOnly && session.has_tts}
          />
        </KVRow>
        {/* Turn count lives on the KPI tile below, reading the computed
         *  summary.total_turns (logical user→assistant pairs). This used to
         *  duplicate it from session.turn_count, which historically counted
         *  every message item — so the header would say 8 while the KPI
         *  said 4 on the same session. One source, no contradiction. */}
      </div>

      <div className="obs-kv">
        <KVRow label="Started">{formatDate(session.started_at)}</KVRow>
        <KVRow label="Ended">{formatDate(session.ended_at)}</KVRow>
        <KVRow label="Recording">
          {session.record_url ? (
            <a
              className="link"
              href={session.record_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Download size={12} /> Download
            </a>
          ) : (
            <span style={{ color: 'hsl(var(--tertiary))' }}>—</span>
          )}
        </KVRow>
      </div>
    </div>
  )
}
