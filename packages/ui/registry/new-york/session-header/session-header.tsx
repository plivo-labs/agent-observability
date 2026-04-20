import { formatDate, formatDuration } from '@/lib/observability-format'
import type { AgentSessionRow } from '@/lib/observability-types'
import { useSession } from '@/lib/observability-hooks'

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-baseline justify-between py-1.5">
    <span className="text-s-400 text-muted-foreground">{label}</span>
    <span className="text-s-400 text-right">{children}</span>
  </div>
)

export const SessionHeader = ({ session: sessionProp }: { session?: AgentSessionRow }) => {
  const { session: hookSession } = useSession()
  const session = sessionProp ?? hookSession

  if (!session) return null

  const capabilities = [
    session.has_stt && 'STT',
    session.has_llm && 'LLM',
    session.has_tts && 'TTS',
  ].filter(Boolean)

  return (
    <div className="rounded-lg border bg-card">
      {/* Title row */}
      <div className="flex items-center justify-between px-5 py-4 border-b">
        <span className="text-p-400 font-medium">Session</span>
        <span className="text-p-400 font-medium tabular-nums">
          {formatDuration(session.duration_ms)}
        </span>
      </div>

      {/* Two-column key-value grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x">
        <div className="flex flex-col px-5 py-3">
          <Row label="Session ID">
            <span className="font-mono text-xs">{session.session_id}</span>
          </Row>
          <Row label="Capabilities">{capabilities.length > 0 ? capabilities.join(', ') : '—'}</Row>
          <Row label="Turns">{session.turn_count ?? '—'}</Row>
        </div>
        <div className="flex flex-col px-5 py-3">
          <Row label="Started">{formatDate(session.started_at)}</Row>
          <Row label="Ended">{formatDate(session.ended_at)}</Row>
          <Row label="Status">
            <span className="capitalize">{session.state || '—'}</span>
          </Row>
          {session.record_url && (
            <Row label="Recording">
              <a href={session.record_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline text-xs">
                Download
              </a>
            </Row>
          )}
        </div>
      </div>
    </div>
  )
}
