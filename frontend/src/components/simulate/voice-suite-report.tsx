/* voice-suite-report.tsx — renders a real-call suite (Truman) inside the
 * Simulate report: one card per persona with lifecycle status, criteria
 * verdict, cost, and the recording. Used for `voice` mode and for the
 * `text_then_voice` escalation. The rich in-call streaming (transcript/audio/
 * take-mic) lives in the Live tab; this is the post-call view. */
import { AlertTriangle, Check, Loader, Phone, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CallBatchResult } from './sim-data'

const initials = (n: string) => n.split(' ').map((w) => w[0]).slice(0, 2).join('')
const isTerminal = (s?: string) => s === 'done' || s === 'failed'

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
    <div className="ao-panel">
      <div className="ao-panel-head">
        <div className="flex min-w-0 items-center gap-2.5">
          <Phone size={16} className="shrink-0 text-success" />
          <div className="flex min-w-0 flex-col">
            <span className="ao-panel-title">
              Real voice calls {mode === 'text_then_voice' ? '(escalated failures)' : ''}
            </span>
            <span className="ao-panel-sub">
              {suite?.agentName ? <>→ {suite.agentName} · </> : null}
              {calls.length ? `${calls.length} call${calls.length > 1 ? 's' : ''}` : 'no calls yet'}
              {done && calls.length ? ` · ${passN}/${calls.length} passed` : ''}
            </span>
          </div>
        </div>
        {!done && (placing || calls.length > 0)
          ? <span className="ao-badge is-accent ao-badge--dot is-pulse shrink-0">In progress</span>
          : done && calls.length
            ? <span className={cn('ao-badge shrink-0', passN === calls.length ? 'is-success' : 'is-danger')}>{passN}/{calls.length} passed</span>
            : null}
      </div>

      <div className="ao-panel-body">
        {/* text_then_voice: one-click escalate (avoids silently placing paid calls) */}
        {mode === 'text_then_voice' && !escalated && (
          failedCount > 0 ? (
            <div className="ao-alert is-warning mb-3 flex-wrap justify-between">
              <span className="flex items-start gap-2"><AlertTriangle size={16} /><span><b>{failedCount}</b> persona{failedCount > 1 ? 's' : ''} failed the text sim. Escalate to real calls? <span className="opacity-80">(rings the phone — Plivo charge)</span></span></span>
              <button type="button" onClick={onEscalate} className="ao-btn ao-btn--primary ao-btn--sm shrink-0">
                <Phone size={14} /> Escalate {failedCount}
              </button>
            </div>
          ) : (
            <div className="mb-1 text-sm text-muted-foreground">All personas passed the text sim — nothing to escalate to voice.</div>
          )
        )}

        {error && <div className="ao-alert is-danger mb-3"><AlertTriangle size={16} /><span>{error}</span></div>}
        {placing && calls.length === 0 && <div className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader size={14} className="animate-spin" /> Placing real calls…</div>}

        <div className="flex flex-col gap-2.5">
          {calls.map((c, i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-3 transition-colors">
              <div className="flex items-center gap-2.5">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold text-white" style={{ background: c.avatar }}>{initials(c.personaName)}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">{c.personaName}</div>
                  <div className="text-xs text-muted-foreground">{c.personaType.replace('_', ' ')}</div>
                </div>
                {isTerminal(c.status) || !c.status
                  ? <span className={cn('ao-badge', c.verdict === 'pass' ? 'is-success' : 'is-danger')}>{c.verdict === 'pass' ? 'Pass' : 'Fail'}</span>
                  : <span className="ao-badge is-success ao-badge--dot is-pulse">{c.status}</span>}
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
              {c.error && <div className="ao-error mt-1.5 text-[11px]">{c.error}</div>}
              {c.recordingUrl && (
                <audio controls preload="none" src={c.recordingUrl} aria-label="Call recording" className="mt-2 h-8 w-full">
                  {/* Raw call recording has no caption file; empty captions satisfy the a11y requirement. */}
                  <track kind="captions" />
                </audio>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
