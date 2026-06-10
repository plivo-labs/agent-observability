'use client'

import { PreviewShell } from '@/components/preview-shell'
import { TurnTranscriptSection } from '@/components/turn-transcript'

// Session-scoped: reads chat history + per-turn metrics from the provider
// (SESSION_ID loaded via the fetch-mock). Mirrors App.tsx's
// <StretchWrap><TurnTranscriptSection /></StretchWrap>.
export default function IslandTurnTranscript() {
  return (
    <PreviewShell withSession>
      <TurnTranscriptSection />
    </PreviewShell>
  )
}
