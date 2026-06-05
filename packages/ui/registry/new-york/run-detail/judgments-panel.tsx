/* judgments-panel.tsx — the ONE shared per-criterion judgments panel used by
 * both the Evals run-detail (selected case) and the Evals case-detail pages, so
 * the pass/fail list renders identically in both. Each judgment is a tinted
 * row with a verdict icon + badge and optional reasoning. Self-contained +
 * on-theme (Neo tokens only). */
import { CheckCircle2, CircleHelp, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { JudgmentResult, JudgmentVerdict } from '@/lib/observability-types'
import { SectionTitle } from '@/components/run-detail/report-sections'

/** Per-criterion verdict tone for the judgments pass/fail list. */
export function verdictTone(v: JudgmentVerdict): 'pass' | 'fail' | 'other' {
  return v === 'pass' ? 'pass' : v === 'fail' ? 'fail' : 'other'
}

export function JudgmentsPanel({ judgments, icon }: {
  judgments: JudgmentResult[]
  /** Optional leading icon for the panel head (case-detail shows a success check). */
  icon?: React.ReactNode
}) {
  if (judgments.length === 0) return null
  const passCount = judgments.filter((j) => j.verdict === 'pass').length
  return (
    <div className="ao-panel">
      <div className="ao-panel-head">
        <SectionTitle icon={icon} title="Judgments" hint="per-criterion pass / fail" />
        <span className="ao-panel-sub">{passCount}/{judgments.length} passed</span>
      </div>
      <div className="flex flex-col gap-2.5 p-4">
        {judgments.map((j, i) => {
          const tone = verdictTone(j.verdict)
          return (
            <div
              key={`${j.intent}-${i}`}
              className={cn(
                'rounded-lg border px-3.5 py-3',
                tone === 'pass' && 'border-[hsl(var(--success-border))] bg-[hsl(var(--success-bg))]',
                tone === 'fail' && 'border-[hsl(var(--destructive-border))] bg-[hsl(var(--destructive-bg))]',
                tone === 'other' && 'border-border bg-muted/40',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2">
                  {tone === 'pass' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    : tone === 'fail' ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                      : <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                  <p className="m-0 text-sm text-foreground">{j.intent}</p>
                </div>
                <span className={cn('ao-badge shrink-0', tone === 'pass' ? 'is-success' : tone === 'fail' ? 'is-danger' : 'is-neutral')}>
                  {tone === 'pass' ? 'pass' : tone === 'fail' ? 'fail' : 'maybe'}
                </span>
              </div>
              {j.reasoning && <p className="ml-6 mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{j.reasoning}</p>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
