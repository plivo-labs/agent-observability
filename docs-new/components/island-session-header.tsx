'use client'

import { PreviewShell } from '@/components/preview-shell'
import { SessionHeader } from '@/components/session-header'

// Session-scoped: reads the resolved session row from the provider (SESSION_ID
// loaded via the fetch-mock). Mirrors App.tsx's <StretchWrap><SessionHeader /></StretchWrap>.
export default function IslandSessionHeader() {
  return (
    <PreviewShell withSession>
      <SessionHeader />
    </PreviewShell>
  )
}
