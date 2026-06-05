'use client'

import { PreviewShell } from '@/components/preview-shell'
// Import the specific file (mirrors App.tsx) — the session-timeline registry
// dir has no index. The alias maps `@/components/session-timeline` to the dir,
// so `/session-timeline` resolves to <dir>/session-timeline.tsx. This module
// pulls in wavesurfer.js + createPortal (window-touching at runtime); the
// resolver loads this island with ssr:false so it never prerenders.
import { SessionTimeline } from '@/components/session-timeline/session-timeline'

// Session-scoped: reads per-turn metrics + recording URL from the provider
// (SESSION_ID loaded via the fetch-mock). Mirrors App.tsx's
// <StretchWrap><SessionTimeline /></StretchWrap>.
export default function IslandSessionTimeline() {
  return (
    <PreviewShell withSession>
      <SessionTimeline />
    </PreviewShell>
  )
}
