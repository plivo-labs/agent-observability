'use client'

import { PreviewShell } from '@/components/preview-shell'
import { MetricSummaryCards } from '@/components/metric-summary-cards'

// Session-scoped: reads the session's headline metrics from the provider
// (SESSION_ID loaded via the fetch-mock). Mirrors App.tsx's
// <StretchWrap><MetricSummaryCards /></StretchWrap>.
export default function IslandMetricSummaryCards() {
  return (
    <PreviewShell withSession>
      <MetricSummaryCards />
    </PreviewShell>
  )
}
