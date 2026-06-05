'use client'

import { PreviewShell } from '@/components/preview-shell'
import { SessionDetailPage } from '@/components/session-detail-page'

// Session-scoped: the full drill-in reads the session loaded by the provider.
// App.tsx's SessionDetailPreview wraps it in
// <AgentObservabilityProvider baseUrl="/api" sessionId={SESSION_ID}>, which is
// exactly what PreviewShell withSession provides. SessionDetailPage takes no props.
export default function IslandSessionDetailPage() {
  return (
    <PreviewShell withSession>
      <SessionDetailPage />
    </PreviewShell>
  )
}
