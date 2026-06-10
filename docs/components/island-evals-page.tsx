'use client'

import { PreviewShell } from '@/components/preview-shell'
import { EvalsPage } from '@/components/evals-page'

// List view: fetches /api/evals via the provider's API client (intercepted by
// the fetch-mock). No sessionId needed — list variant. Mirrors App.tsx's
// EvalsListPreview: <EvalsPage onRunClick={() => {}} /> under the app provider.
export default function IslandEvalsPage() {
  return (
    <PreviewShell>
      <EvalsPage onRunClick={() => {}} />
    </PreviewShell>
  )
}
