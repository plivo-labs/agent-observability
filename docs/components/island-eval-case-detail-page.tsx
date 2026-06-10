'use client'

import {
  PreviewShell,
  EVAL_RUN_ID,
  EVAL_CASE_ID,
  EVAL_FAIL_CASE_ID,
} from '@/components/preview-shell'
import { EvalCaseDetailPage } from '@/components/eval-case-detail-page'

// Standalone view: normally rendered inside the drawer EvalRunDetailPage opens.
// App.tsx's EvalCaseDetailPreview surfaces it standalone and STACKS two cases —
// a passing one above a failing one — so reviewers see both pass- and
// fail-tinted judgment cards in the same shot. Width is constrained to the
// typical drawer size. List variant (no sessionId); the page fetches
// /api/evals/:runId/cases/:caseId via the provider's API client.
export default function IslandEvalCaseDetailPage() {
  return (
    <PreviewShell>
      <div className="flex flex-col gap-6 max-w-3xl mx-auto">
        <div className="border bg-card">
          <EvalCaseDetailPage
            runId={EVAL_RUN_ID}
            caseId={EVAL_CASE_ID}
            onBack={() => {}}
          />
        </div>
        {EVAL_FAIL_CASE_ID !== EVAL_CASE_ID && (
          <div className="border bg-card">
            <EvalCaseDetailPage
              runId={EVAL_RUN_ID}
              caseId={EVAL_FAIL_CASE_ID}
              onBack={() => {}}
            />
          </div>
        )}
      </div>
    </PreviewShell>
  )
}
