'use client'

import { PreviewShell } from '@/components/preview-shell'
import { SessionEvents } from '@/components/session-events'

// Session-scoped: reads raw session events from the provider (SESSION_ID loaded
// via the fetch-mock). Mirrors App.tsx's <StretchWrap><SessionEvents /></StretchWrap>.
export default function IslandSessionEvents() {
  return (
    <PreviewShell withSession>
      <SessionEvents />
    </PreviewShell>
  )
}
