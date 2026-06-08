/* transcript.tsx — shared Truman-style run-detail transcript.
 * Role-aligned turn rows: caller/user right-aligned, agent left-aligned; a
 * left gutter with a zero-padded index + mm:ss timestamp (when `ts` present),
 * a mono UPPERCASE role chip, and a tinted bubble per role. On-theme (Neo
 * tokens only). Prop-driven + self-contained — reused by Simulate + Evals. */
import { AlertTriangle, Timer } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TranscriptTurn {
  role: 'user' | 'agent'
  t: string
  ms?: number | null
  flag?: string | null
  ts?: number
}

const mmss = (sec: number) => {
  const s = Math.max(0, Math.floor(sec))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function Transcript({ turns, highlight, refMap }: {
  turns: TranscriptTurn[]
  highlight?: number | null
  refMap?: React.MutableRefObject<Record<number, HTMLDivElement | null>>
}) {
  if (turns.length === 0) {
    return <div className="py-8 text-center text-sm text-muted-foreground">No turns yet.</div>
  }
  return (
    <div className="flex flex-col gap-3">
      {turns.map((t, i) => {
        const isUser = t.role === 'user'
        return (
          <div
            key={i}
            ref={(el) => { if (refMap) refMap.current[i] = el }}
            className={cn('flex gap-2.5', isUser ? 'flex-row-reverse' : '')}
            style={highlight === i ? { outline: '2px solid hsl(var(--ring))', outlineOffset: 4, borderRadius: 12 } : undefined}
          >
            {/* gutter — zero-padded index + mm:ss */}
            <div className="flex w-10 shrink-0 flex-col items-center gap-0.5 pt-1 text-[10px] tabular-nums text-muted-foreground/70">
              <span className="font-mono">{String(i + 1).padStart(2, '0')}</span>
              {t.ts != null && <span className="font-mono">{mmss(t.ts)}</span>}
            </div>
            <div className={cn('flex min-w-0 flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
              {/* role chip */}
              <span className={cn('rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em]',
                isUser ? 'bg-muted text-muted-foreground' : 'bg-primary/12 text-primary')}>
                {isUser ? 'caller' : 'agent'}
              </span>
              {/* bubble */}
              <div className={cn('max-w-[46ch] rounded-xl px-3 py-2 text-sm leading-relaxed',
                isUser ? 'bg-muted text-foreground' : 'bg-primary/8 text-foreground',
                t.flag ? 'ring-1 ring-destructive/40' : '')}>
                {t.t}
              </div>
              {/* meta — latency + flag */}
              {(t.ms != null || t.flag) && (
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  {!isUser && t.ms != null && (
                    <span className={cn('inline-flex items-center gap-1', t.ms > 800 ? 'text-destructive' : '')}>
                      <Timer size={11} />{t.ms}ms
                    </span>
                  )}
                  {t.flag && (
                    <span className="inline-flex items-center gap-1 text-destructive">
                      <AlertTriangle size={11} /> {t.flag}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
