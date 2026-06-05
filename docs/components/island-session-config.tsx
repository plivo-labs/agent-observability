'use client'

import { PreviewShell } from '@/components/preview-shell'
import { SessionConfig } from '@/components/session-config'

// Session-scoped: reads the captured options blob from the provider (SESSION_ID
// loaded via the fetch-mock). Mirrors App.tsx's <StretchWrap><SessionConfig /></StretchWrap>.
export default function IslandSessionConfig() {
  return (
    <PreviewShell withSession>
      <SessionConfig />
    </PreviewShell>
  )
}
