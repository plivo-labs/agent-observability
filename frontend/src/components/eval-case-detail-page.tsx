import { ArrowLeft, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CaseStatusBadge, VerdictBadge } from '@/components/eval-status-badge'
import { EvalEventTimeline } from '@/components/eval-event-timeline'
import { formatDuration } from '@/lib/observability-format'
import { useEvalCase } from '@/lib/observability-hooks'

export const EvalCaseDetailPage = ({
  runId,
  caseId,
  onBack,
}: {
  runId: string
  caseId: string
  onBack?: () => void
}) => {
  const { evalCase, loading, error } = useEvalCase(runId, caseId)

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          <span className="text-s-400">Loading case...</span>
        </div>
      </div>
    )
  }

  if (error || !evalCase) {
    return (
      <div className="p-12 text-center text-destructive">
        <p>Failed to load case: {error ?? 'not found'}</p>
        {onBack && (
          <Button variant="outline" onClick={onBack} className="mt-4">
            <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="p-6">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-4 inline-flex items-center gap-1 text-s-400 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to run
        </button>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-h3-600 font-semibold font-mono">{evalCase.name}</h1>
        <CaseStatusBadge status={evalCase.status} />
      </div>
      <div className="mt-1 text-s-400 text-muted-foreground space-x-3">
        {evalCase.file && <span className="font-mono">{evalCase.file}</span>}
        <span>·</span>
        <span>{formatDuration(evalCase.duration_ms)}</span>
        {evalCase.events.length > 0 && (
          <>
            <span>·</span>
            <span>{evalCase.events.length} events</span>
          </>
        )}
        {evalCase.judgments.length > 0 && (
          <>
            <span>·</span>
            <span>{evalCase.judgments.length} judgments</span>
          </>
        )}
      </div>

      {evalCase.user_input && (
        <div className="mt-6">
          <h2 className="text-xs-500 text-muted-foreground uppercase tracking-wide mb-2">
            User input
          </h2>
          <blockquote className="border-l-4 border-primary/40 bg-muted/20 py-2 px-4 text-s-400 whitespace-pre-wrap">
            {evalCase.user_input}
          </blockquote>
        </div>
      )}

      <div className="mt-8">
        <h2 className="text-xs-500 text-muted-foreground uppercase tracking-wide mb-2">
          Transcript
        </h2>
        <EvalEventTimeline events={evalCase.events} />
      </div>

      {evalCase.judgments.length > 0 && (
        <div className="mt-8">
          <h2 className="text-xs-500 text-muted-foreground uppercase tracking-wide mb-2">
            Judgments
          </h2>
          <div className="flex flex-col gap-2">
            {evalCase.judgments.map((j, i) => (
              <div
                key={`${j.intent}-${i}`}
                className={`rounded-md border p-3 ${
                  j.verdict === 'fail' ? 'border-destructive/40 bg-destructive/5' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-s-500 font-medium">{j.intent}</p>
                  <VerdictBadge verdict={j.verdict} />
                </div>
                {j.reasoning && (
                  <p className="mt-2 text-s-400 text-muted-foreground whitespace-pre-wrap">
                    {j.reasoning}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {evalCase.failure && (
        <div className="mt-8 rounded-md border border-destructive/40 bg-destructive/5 p-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <h2 className="text-s-500 font-semibold text-destructive">
              Failure ({evalCase.failure.kind})
            </h2>
          </div>
          {evalCase.failure.message && (
            <p className="mt-2 text-s-400 font-mono whitespace-pre-wrap">
              {evalCase.failure.message}
            </p>
          )}
          {evalCase.failure.stack && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs-500 text-muted-foreground uppercase tracking-wide">
                Stack trace
              </summary>
              <pre className="mt-2 text-xs-400 font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap">
                {evalCase.failure.stack}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
