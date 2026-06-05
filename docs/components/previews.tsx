'use client'

import type { ComponentType } from 'react'
import dynamic from 'next/dynamic'

// ssr:false keeps every island out of the static HTML — each live preview is a
// pure client island fed by the browser fetch-mock (and a couple, e.g.
// session-timeline, touch `window`/wavesurfer at runtime). ssr:false is only
// legal inside a client component, hence this 'use client' module.
//
// Wiring all 15 islands into this dynamic-import map puts every one in the
// build graph: `components/mdx.tsx` imports ComponentPreview, so `next build`
// must resolve + compile each island (and the registry component it pulls in
// through the `@/components/...` alias). This map is the compile gate.

function PreviewFallback({ label }: { label: string }) {
  return (
    <div className="not-prose border border-border bg-bg2/40 p-6 text-sm text-muted-foreground">
      Loading {label} preview…
    </div>
  )
}

const lazy = (
  loader: () => Promise<{ default: ComponentType }>,
  label: string,
) => dynamic(loader, { ssr: false, loading: () => <PreviewFallback label={label} /> })

// slug → island. The slugs match the planned MDX filenames exactly.
const ISLANDS: Record<string, ComponentType> = {
  // Pages
  'sessions-page': lazy(() => import('@/components/island-sessions-page'), 'sessions page'),
  'session-detail-page': lazy(
    () => import('@/components/island-session-detail-page'),
    'session detail page',
  ),
  'evals-page': lazy(() => import('@/components/island-evals-page'), 'evals page'),
  'eval-run-detail-page': lazy(
    () => import('@/components/island-eval-run-detail-page'),
    'eval run detail page',
  ),
  // Components
  'metric-summary-cards': lazy(
    () => import('@/components/island-metric-summary-cards'),
    'metric summary cards',
  ),
  'session-header': lazy(
    () => import('@/components/island-session-header'),
    'session header',
  ),
  'turn-transcript': lazy(
    () => import('@/components/island-turn-transcript'),
    'turn transcript',
  ),
  'session-events': lazy(
    () => import('@/components/island-session-events'),
    'session events',
  ),
  'session-config': lazy(
    () => import('@/components/island-session-config'),
    'session config',
  ),
  'eval-case-detail-page': lazy(
    () => import('@/components/island-eval-case-detail-page'),
    'eval case detail',
  ),
  'session-timeline': lazy(
    () => import('@/components/island-session-timeline'),
    'session timeline',
  ),
  // Charts
  'latency-percentiles': lazy(
    () => import('@/components/island-latency-chart'),
    'latency percentiles chart',
  ),
  'pipeline-breakdown': lazy(
    () => import('@/components/island-pipeline-breakdown'),
    'pipeline breakdown chart',
  ),
  'latency-over-turns': lazy(
    () => import('@/components/island-latency-over-turns'),
    'latency over turns chart',
  ),
  'token-usage': lazy(
    () => import('@/components/island-token-usage'),
    'token usage',
  ),
}

export type PreviewSlug = keyof typeof ISLANDS

/**
 * Live-preview resolver mounted in MDX as `<ComponentPreview slug="…" />`.
 * Resolves the slug to its ssr:false client island. Unknown slugs render a
 * visible error so a typo in MDX is caught at render time rather than silently
 * dropping the preview.
 */
export function ComponentPreview({ slug }: { slug: string }) {
  const Island = ISLANDS[slug]
  if (!Island) {
    return (
      <div className="not-prose border border-destructive/50 bg-destructive/10 p-6 text-sm text-destructive">
        Unknown preview slug: <code>{slug}</code>
      </div>
    )
  }
  return <Island />
}

// Legacy named exports kept so the existing chart.mdx / sessions.mdx (which use
// <LatencyChartPreview /> and <SessionsPagePreview />) keep compiling. New docs
// pages should use <ComponentPreview slug="…" /> instead.
export function LatencyChartPreview() {
  return <ComponentPreview slug="latency-percentiles" />
}

export function SessionsPagePreview() {
  return <ComponentPreview slug="sessions-page" />
}
