'use client'

import { PreviewShell, EVAL_RUN_ID } from '@/components/preview-shell'
import { EvalRunDetailPage } from '@/components/eval-run-detail-page'

// Standalone page: fetches /api/evals/:runId (+ cases) via the provider's API
// client (intercepted by the fetch-mock). No sessionId needed — list variant.
// Mirrors App.tsx's EvalRunDetailPreview: <EvalRunDetailPage runId={EVAL_RUN_ID} />
// under the app provider (onCaseClick omitted so the built-in drawer is used).
export default function IslandEvalRunDetailPage() {
  return (
    <PreviewShell>
      <EvalRunDetailPage runId={EVAL_RUN_ID} />
    </PreviewShell>
  )
}
