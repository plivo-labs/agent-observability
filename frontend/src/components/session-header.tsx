import { Download, Radio } from 'lucide-react'
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

export const SessionHeader = ({ session: sessionProp }: { session?: AgentSessionRow }) => {
  const { session: hookSession } = useSession()
  const session = sessionProp ?? hookSession
  if (!session) return null

  const stateClass = session.state === 'ended' ? 'status-ended' : 'status-live'

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
        <div className="dur">{formatDuration(session.duration_ms)}</div>
      </div>

      <div className="obs-kv">
        <KVRow label="Session ID">
          <span className="mono">{session.session_id}</span>
        </KVRow>
        <KVRow label="Capabilities">
          <CapsChips
            stt={session.has_stt}
            llm={session.has_llm}
            tts={session.has_tts}
          />
        </KVRow>
        <KVRow label="Turns">{session.turn_count ?? '—'}</KVRow>
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
