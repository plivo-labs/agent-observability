'use client'

import { PreviewShell } from '@/components/preview-shell'
import { TokenUsageSection } from '@/components/token-usage-section'

// Session-scoped: reads per-turn token usage from the provider (SESSION_ID
// loaded via the fetch-mock). Mirrors App.tsx's <StretchWrap><TokenUsageSection /></StretchWrap>.
export default function IslandTokenUsage() {
  return (
    <PreviewShell withSession>
      <TokenUsageSection />
    </PreviewShell>
  )
}
