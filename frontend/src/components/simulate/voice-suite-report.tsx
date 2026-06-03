/* voice-suite-report.tsx — renders a real-call suite (Truman) inside the
 * Simulate report: one card per persona with lifecycle status, criteria
 * verdict, cost, and the recording. Used for `voice` mode and for the
 * `text_then_voice` escalation. The rich in-call streaming (transcript/audio/
 * take-mic) lives in the Live tab; this is the post-call view. */
import { Check, Loader, Phone, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CallBatchResult } from './sim-data'

const initials = (n: string) => n.split(' ').map((w) => w[0]).slice(0, 2).join('')
const isTerminal = (s?: string) => s === 'done' || s === 'failed'
const verdictPill = (v: 'pass' | 'fail') =>
  cn('rounded-full px-2 py-0.5 text-xs font-semibold', v === 'pass' ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive')

export function VoiceSuiteReport({
  mode, suite, error, placing, failedCount, escalated, onEscalate,
}: {
  mode: string
  suite: CallBatchResult | null
  error: string | null
  placing: boolean
  failedCount: number
  escalated: boolean
  onEscalate: () => void
}) {
  const calls = suite?.calls ?? []
  const done = calls.length > 0 && calls.every((c) => !c.status || isTerminal(c.status))
  const passN = calls.filter((c) => c.verdict === 'pass').length

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <Phone size={16} className="text-success" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-foreground">
            Real voice calls {mode === 'text_then_voice' ? '(escalated failures)' : ''}
          </div>
          <div className="text-xs text-muted-foreground">
            {suite?.agentName ? <>→ {suite.agentName} · </> : null}
            {calls.length ? `${calls.length} call${calls.length > 1 ? 's' : ''}` : 'no calls yet'}
            {done && calls.length ? ` · ${passN}/${calls.length} passed` : ''}
          </div>
        </div>
        {!done && (placing || calls.length > 0) && <Loader size={15} className="animate-spin text-muted-foreground" />}
      </div>

      <div className="p-4">
        {/* text_then_voice: one-click escalate (avoids silently placing paid calls) */}
        {mode === 'text_then_voice' && !escalated && (
          failedCount > 0 ? (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/8 px-3.5 py-2.5 text-sm">
              <span><b>{failedCount}</b> persona{failedCount > 1 ? 's' : ''} failed the text sim. Escalate to real calls? <span className="text-muted-foreground">(rings the phone — Plivo charge)</span></span>
              <button onClick={onEscalate} className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium hover:bg-primary/90" style={{ color: 'hsl(var(--primary-foreground))' }}>
                <Phone size={14} /> Escalate {failedCount}
              </button>
            </div>
          ) : (
            <div className="mb-1 text-sm text-muted-foreground">All personas passed the text sim — nothing to escalate to voice.</div>
          )
        )}

        {error && <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive">{error}</div>}
        {placing && calls.length === 0 && <div className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader size={14} className="animate-spin" /> Placing real calls…</div>}

        <div className="flex flex-col gap-2.5">
          {calls.map((c, i) => (
            <div key={i} className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-2.5">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold text-white" style={{ background: c.avatar }}>{initials(c.personaName)}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">{c.personaName}</div>
                  <div className="text-xs text-muted-foreground">{c.personaType.replace('_', ' ')}</div>
                </div>
                {isTerminal(c.status) || !c.status
                  ? <span className={verdictPill(c.verdict)}>{c.verdict === 'pass' ? 'Pass' : 'Fail'}</span>
                  : <span className="inline-flex items-center gap-1 text-[11px] text-success"><span className="size-1.5 rounded-full bg-current animate-pulse" />{c.status}</span>}
              </div>

              {(isTerminal(c.status) || !c.status) && (c.judge?.criteria?.length ?? 0) > 0 && (
                <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
                  {c.judge.criteria.map((cr) => (
                    <div key={cr.name} className="flex items-start gap-2">
                      <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full', cr.pass ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive')}>{cr.pass ? <Check size={11} /> : <X size={11} />}</span>
                      <div className="min-w-0"><span className="text-xs font-medium text-foreground">{cr.name}</span> <span className="text-xs text-muted-foreground">— {cr.justification}</span></div>
                    </div>
                  ))}
                </div>
              )}
              {c.error && <div className="mt-1.5 text-[11px] text-destructive">{c.error}</div>}
              {c.recordingUrl && <audio controls preload="none" src={c.recordingUrl} className="mt-2 h-8 w-full" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
