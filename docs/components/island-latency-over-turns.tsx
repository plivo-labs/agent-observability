'use client'

import { PreviewShell } from '@/components/preview-shell'
import { LatencyOverTurnsChart } from '@/components/latency-over-turns-chart'

// Session-scoped: reads per-turn metrics from the provider (SESSION_ID loaded
// via the fetch-mock). Mirrors App.tsx's <StretchWrap><LatencyOverTurnsChart /></StretchWrap>.
export default function IslandLatencyOverTurns() {
  return (
    <PreviewShell withSession>
      <LatencyOverTurnsChart />
    </PreviewShell>
  )
}
