'use client'

import { PreviewShell } from '@/components/preview-shell'
import { SessionsPage } from '@/components/sessions-page'

// SessionsPage is a list view: it fetches /api/sessions itself via the
// provider's hooks and reads nuqs query state for pagination/filters.
export default function IslandSessionsPage() {
  return (
    <PreviewShell>
      <SessionsPage onSessionClick={() => {}} />
    </PreviewShell>
  )
}
