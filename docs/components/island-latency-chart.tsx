'use client'

import { PreviewShell } from '@/components/preview-shell'
import { LatencyPercentilesChart } from '@/components/latency-percentiles-chart'

// The chart reads metrics from the provider (which loaded SESSION_ID via the
// fetch-mock), so the shell must carry a session.
export default function IslandLatencyChart() {
  return (
    <PreviewShell withSession>
      <LatencyPercentilesChart />
    </PreviewShell>
  )
}
