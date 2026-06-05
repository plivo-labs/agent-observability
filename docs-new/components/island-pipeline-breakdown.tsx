'use client'

import { PreviewShell } from '@/components/preview-shell'
import { PipelineBreakdownChart } from '@/components/pipeline-breakdown-chart'

// Session-scoped: reads per-turn metrics from the provider (SESSION_ID loaded
// via the fetch-mock). Mirrors App.tsx's <StretchWrap><PipelineBreakdownChart /></StretchWrap>.
export default function IslandPipelineBreakdown() {
  return (
    <PreviewShell withSession>
      <PipelineBreakdownChart />
    </PreviewShell>
  )
}
