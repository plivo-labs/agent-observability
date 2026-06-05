'use client'

import type { ReactNode } from 'react'
// Side-effect import: installs the fetch-mock before the provider effect runs.
import '@/components/mock-fetch-boot'
import { NuqsAdapter } from 'nuqs/adapters/next/app'
import { AgentObservabilityProvider } from '@/lib/observability-provider'
import mockData from '@/lib/mock-data.json'

export const SESSION_ID = mockData.sessions[0].session_id

// Eval preview constants — mirror docs/src/App.tsx (~lines 32-50). The
// eval-run / eval-case islands feed these to the registry pages so they
// resolve a real run + cases out of mock-data.json (via the fetch-mock).
type MockCase = {
  case_id: string
  judgments?: Array<{ verdict?: string }>
}

const EVAL_CASES: MockCase[] =
  (mockData as { evals?: Array<{ cases?: MockCase[] }> }).evals?.[0]?.cases ?? []

export const EVAL_RUN_ID =
  (mockData as { evals?: Array<{ run_id: string }> }).evals?.[0]?.run_id ??
  'run_pytest_2026_04_22'

export const EVAL_CASE_ID = EVAL_CASES[0]?.case_id ?? 'case_001'

// First case with a failing judgment so the preview shows the fail-state
// styling stacked under the passing case above it.
export const EVAL_FAIL_CASE_ID =
  EVAL_CASES.find((c) => c.judgments?.some((j) => j.verdict === 'fail'))
    ?.case_id ?? EVAL_CASE_ID

/**
 * Mirrors docs/src/App.tsx wiring: a provider pointed at "/api" (intercepted
 * by the fetch-mock) wrapped in the nuqs adapter so registry pages that read
 * URL query state (sessions-page) work under the App Router.
 */
export function PreviewShell({
  children,
  withSession = false,
}: {
  children: ReactNode
  withSession?: boolean
}) {
  return (
    <NuqsAdapter>
      <AgentObservabilityProvider
        baseUrl="/api"
        sessionId={withSession ? SESSION_ID : undefined}
      >
        <div className="not-prose border border-border bg-bg2/40 p-6">
          {children}
        </div>
      </AgentObservabilityProvider>
    </NuqsAdapter>
  )
}
