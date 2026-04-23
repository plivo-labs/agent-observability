import { useEffect, useMemo, useState } from 'react'
import {
  BrowserRouter,
  Navigate,
  Routes,
  Route,
  useNavigate,
  useParams,
} from 'react-router'
import type { HighlighterCore } from 'shiki'
import { AgentObservabilityProvider } from '@/lib/observability-provider'
import { MetricSummaryCards } from '@/components/metric-summary-cards'
import { LatencyPercentilesChart } from '@/components/latency-percentiles-chart'
import { PipelineBreakdownChart } from '@/components/pipeline-breakdown-chart'
import { LatencyOverTurnsChart } from '@/components/latency-over-turns-chart'
import { TokenUsageSection } from '@/components/token-usage-section'
import { SessionHeader } from '@/components/session-header'
import { TurnTranscriptSection } from '@/components/turn-transcript'
import { SessionTimeline } from '@/components/session-timeline/session-timeline'
import { SessionEvents } from '@/components/session-events'
import { SessionConfig } from '@/components/session-config'
import { SessionsPage } from '@/components/sessions-page'
import { SessionDetailPage } from '@/components/session-detail-page'
import mockData from './mock-data.json'
import './docs.css'

const SESSION_ID = mockData.sessions[0].session_id

type Stage = 'centered' | 'left' | 'stretch'

interface PropDef {
  name: string
  type: string
  default?: string
  required?: boolean
  description: string
}

interface DocEntry {
  id: string
  label: string
  group: 'Core' | 'Hooks' | 'Pages' | 'Components' | 'Charts' | 'Utilities'
  pkg: string
  description: string
  stage?: Stage
  /** Omit to skip the Preview section (use for context providers and other
   *  non-rendering APIs). */
  render?: () => React.ReactNode
  /** Function signature line (hooks / utilities). Rendered as a code block
   *  above the Parameters table. */
  signature?: string
  /** Prop documentation rendered as a table. Empty array means "no props".
   *  Header is "Parameters" for hooks, "Props" otherwise. */
  props?: PropDef[]
  /** Return shape for hooks / utilities — rendered as a code block. */
  returns?: string
  /** Usage code snippet shown under the preview. */
  usage?: string
}

function SessionsListPreview() {
  return <SessionsPage onSessionClick={() => {}} />
}

function SessionDetailPreview() {
  return (
    <AgentObservabilityProvider baseUrl="/api" sessionId={SESSION_ID}>
      <SessionDetailPage onBack={() => {}} />
    </AgentObservabilityProvider>
  )
}

function StretchWrap({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 24, width: '100%', background: 'hsl(var(--bg2) / 0.4)' }}>
      {children}
    </div>
  )
}

const ENTRIES: DocEntry[] = [
  {
    id: 'observability-provider',
    label: 'Agent Observability Provider',
    group: 'Core',
    pkg: 'observability-provider',
    description:
      'Context provider that every other component from this library expects. Install and mount it once, high in your tree — it creates the API client, resolves the current session, and shares the hooks that drive the rest of the UI. No visual output of its own.',
    props: [
      {
        name: 'baseUrl',
        type: 'string',
        required: true,
        description:
          'Base URL of your Agent Observability API. In Vite dev, pair this with a /api proxy; in production, point it at the deployed service.',
      },
      {
        name: 'sessionId',
        type: 'string',
        description:
          'Optional session id the provider loads up-front. Downstream detail components (SessionHeader, SessionTimeline, TurnTranscriptSection, SessionEvents, SessionConfig, charts) read this through the context. Omit on list pages.',
      },
      {
        name: 'children',
        type: 'React.ReactNode',
        required: true,
        description: 'Your application tree.',
      },
    ],
    usage: `import { AgentObservabilityProvider } from '@/lib/observability-provider'
import { SessionDetailPage } from '@/components/session-detail-page'

// Wrap the subtree that needs session data. Pass a sessionId when
// rendering a single-session page; list pages can drop it.
export function App({ sessionId }: { sessionId: string }) {
  return (
    <AgentObservabilityProvider
      baseUrl="https://observability.example.com/api"
      sessionId={sessionId}
    >
      <SessionDetailPage onBack={() => history.back()} />
    </AgentObservabilityProvider>
  )
}`,
  },

  // ───── Hooks ─────────────────────────────────────────────────────────
  {
    id: 'use-sessions',
    label: 'useSessions',
    group: 'Hooks',
    pkg: 'observability-hooks',
    description:
      'Paginated session list fetcher. Holds its own cursor — pass a stable initialOffset and drive pagination with setOffset. Refetches automatically whenever filters or offset change.',
    signature:
      'useSessions(limit?: number, initialOffset?: number, filters?: SessionsFilters): { sessions, meta, loading, error, offset, setOffset }',
    props: [
      {
        name: 'limit',
        type: 'number',
        default: '20',
        description: 'Page size. The server clamps to [1, 20].',
      },
      {
        name: 'initialOffset',
        type: 'number',
        default: '0',
        description:
          'Starting offset. Syncs when the prop changes (so you can drive it from URL state) AND exposes setOffset for local pagination.',
      },
      {
        name: 'filters',
        type: 'SessionsFilters',
        description:
          'Optional filters: { accountId?, startedFrom?, startedTo? }. Offset auto-resets to 0 when any filter changes.',
      },
    ],
    returns:
      '{ sessions: AgentSessionRow[], meta: PlivoMeta, loading: boolean, error: string | null, offset: number, setOffset: (n: number) => void }',
    usage: `import { useSessions } from '@/lib/observability-hooks'

export function MyList() {
  const { sessions, meta, loading, offset, setOffset } = useSessions(20, 0, {
    accountId: 'acc_demo',
  })
  if (loading) return <Spinner />
  return (
    <>
      {sessions.map((s) => (
        <Row key={s.id} session={s} />
      ))}
      <Pagination
        offset={offset}
        limit={meta.limit}
        total={meta.total_count}
        onChange={setOffset}
      />
    </>
  )
}`,
  },
  {
    id: 'use-session',
    label: 'useSession',
    group: 'Hooks',
    pkg: 'observability-hooks',
    description:
      'Returns the single session loaded by the provider. Read-only convenience wrapper — the actual fetch is done by AgentObservabilityProvider when a sessionId is passed to it.',
    signature: 'useSession(): { session, loading, error }',
    props: [],
    returns:
      '{ session: AgentSessionRow | null, loading: boolean, error: string | null }',
    usage: `import { useSession } from '@/lib/observability-hooks'

function SessionTitle() {
  const { session, loading, error } = useSession()
  if (loading) return <span>Loading…</span>
  if (error || !session) return <span>—</span>
  return <h1>{session.session_id}</h1>
}`,
  },
  {
    id: 'use-timeline',
    label: 'useTimeline',
    group: 'Hooks',
    pkg: 'observability-hooks',
    description:
      'Derives timeline-specific data from the current session: per-turn metrics, the recording URL, and the highlighted-turn state shared with the transcript.',
    signature:
      'useTimeline(): { metrics, recordUrl, sessionCreatedAt, highlightedTurn, setHighlightedTurn }',
    props: [],
    returns:
      '{ metrics: SessionMetrics | null, recordUrl: string | null, sessionCreatedAt: string | undefined, highlightedTurn: number | null, setHighlightedTurn: (n: number | null) => void }',
    usage: `import { useTimeline } from '@/lib/observability-hooks'

function CustomTimeline() {
  const { metrics, setHighlightedTurn } = useTimeline()
  // Click a turn → both timeline AND transcript scroll into view
  return metrics?.turns.map((t) => (
    <button
      key={t.turn_number}
      onClick={() => setHighlightedTurn(t.turn_number)}
    >
      Turn {t.turn_number}
    </button>
  ))
}`,
  },
  {
    id: 'use-transcript',
    label: 'useTranscript',
    group: 'Hooks',
    pkg: 'observability-hooks',
    description:
      'Returns the structured turns, the raw chat history, and the highlighted-turn state — the data the built-in TurnTranscriptSection consumes.',
    signature:
      'useTranscript(): { turns, chatHistory, metrics, highlightedTurn, setHighlightedTurn }',
    props: [],
    returns:
      '{ turns: TurnRecord[], chatHistory: ChatItem[] | null, metrics: SessionMetrics | null, highlightedTurn: number | null, setHighlightedTurn: (n: number | null) => void }',
    usage: `import { useTranscript } from '@/lib/observability-hooks'

function TurnCount() {
  const { turns } = useTranscript()
  return <span>{turns.length} turns</span>
}`,
  },
  {
    id: 'use-performance',
    label: 'usePerformance',
    group: 'Hooks',
    pkg: 'observability-hooks',
    description:
      'Extracts metrics + the MetricsSummary roll-up from the current session. Used by all the chart components to build their data series.',
    signature: 'usePerformance(): { metrics, summary }',
    props: [],
    returns:
      '{ metrics: SessionMetrics | null, summary: MetricsSummary | null }',
    usage: `import { usePerformance } from '@/lib/observability-hooks'

function ToolCallCount() {
  const { summary } = usePerformance()
  if (!summary) return null
  return <span>{summary.total_tool_calls} tool calls</span>
}`,
  },
  {
    id: 'use-events',
    label: 'useEvents',
    group: 'Hooks',
    pkg: 'observability-hooks',
    description:
      'Raw session events (function calls, agent_state_changed, speech_created, etc.) as captured by the SDK. Returns null if the provider has not loaded a session yet.',
    signature: 'useEvents(): SessionEvent[] | null',
    props: [],
    returns: 'SessionEvent[] | null',
    usage: `import { useEvents } from '@/lib/observability-hooks'

function FunctionCallCount() {
  const events = useEvents()
  const n = events?.filter((e) => e.type === 'function_call').length ?? 0
  return <span>{n} tool invocations</span>
}`,
  },
  {
    id: 'use-options',
    label: 'useOptions',
    group: 'Hooks',
    pkg: 'observability-hooks',
    description:
      'Snapshot of the agent configuration captured with the session — model IDs, voice settings, tool list, runtime options. Returns null before load.',
    signature: 'useOptions(): Record<string, unknown> | null',
    props: [],
    returns: 'Record<string, unknown> | null',
    usage: `import { useOptions } from '@/lib/observability-hooks'

function ModelBadge() {
  const options = useOptions()
  const model = (options as { llm?: { model?: string } } | null)?.llm?.model
  return model ? <Badge>{String(model)}</Badge> : null
}`,
  },

  {
    id: 'sessions-page',
    label: 'Sessions Page',
    group: 'Pages',
    pkg: 'sessions-page',
    description:
      'Tabular index of captured sessions. Monospace IDs, tabular-number duration, capability badges, row-hover navigation, and server-backed pagination.',
    stage: 'stretch',
    render: () => <SessionsListPreview />,
    props: [
      {
        name: 'onSessionClick',
        type: '(sessionId: string) => void',
        description:
          'Fires when a row is clicked. Wire it up to your router for navigation. Omit to render a non-interactive list.',
      },
    ],
    usage: `import { AgentObservabilityProvider } from '@/lib/observability-provider'
import { SessionsPage } from '@/components/sessions-page'
import { useNavigate } from 'react-router'

export function SessionsRoute() {
  const navigate = useNavigate()
  return (
    <AgentObservabilityProvider baseUrl="https://observability.example.com/api">
      <SessionsPage onSessionClick={(id) => navigate(\`/sessions/\${id}\`)} />
    </AgentObservabilityProvider>
  )
}`,
  },
  {
    id: 'session-detail-page',
    label: 'Session Detail Page',
    group: 'Pages',
    pkg: 'session-detail-page',
    description:
      'Full drill-in view for a single session. Combines the session header, a tabbed timeline / transcript / events / config / performance layout, and the recording player.',
    stage: 'stretch',
    render: () => <SessionDetailPreview />,
    props: [
      {
        name: 'onBack',
        type: '() => void',
        description:
          'Handler for the breadcrumb "Sessions" link at the top of the page. Omit to render without a back control.',
      },
    ],
    usage: `import { AgentObservabilityProvider } from '@/lib/observability-provider'
import { SessionDetailPage } from '@/components/session-detail-page'
import { useNavigate, useParams } from 'react-router'

export function SessionDetailRoute() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  return (
    <AgentObservabilityProvider
      baseUrl="https://observability.example.com/api"
      sessionId={sessionId}
    >
      <SessionDetailPage onBack={() => navigate('/sessions')} />
    </AgentObservabilityProvider>
  )
}`,
  },

  {
    id: 'metric-summary-cards',
    label: 'Metric Summary Cards',
    group: 'Components',
    pkg: 'metric-summary-cards',
    description:
      'A row of compact metric tiles for the headline observability numbers — turn count, avg latency, token totals. Small, dense, and meant to sit above the fold on the session detail page.',
    stage: 'left',
    render: () => <MetricSummaryCards />,
    props: [
      {
        name: 'metrics',
        type: 'SessionMetrics | null',
        description:
          'Override the metrics resolved from provider context. Useful when rendering ad-hoc aggregates or in stories. Defaults to the current session’s metrics.',
      },
    ],
    usage: `import { MetricSummaryCards } from '@/components/metric-summary-cards'

// Inside a provider tree — reads the current session via context
<MetricSummaryCards />

// Or pass your own metrics
<MetricSummaryCards metrics={customMetrics} />`,
  },
  {
    id: 'session-header',
    label: 'Session Header',
    group: 'Components',
    pkg: 'session-header',
    description:
      'The identity strip at the top of every session detail page. Shows session ID, capability badges, duration, start/end timestamps, and a download-recording action.',
    stage: 'stretch',
    render: () => (
      <StretchWrap>
        <SessionHeader />
      </StretchWrap>
    ),
    props: [
      {
        name: 'session',
        type: 'AgentSessionRow',
        description:
          'Override the session resolved from provider context. Handy when embedding the header in a list or custom page.',
      },
    ],
    usage: `import { SessionHeader } from '@/components/session-header'

// Context-driven (preferred)
<SessionHeader />

// With an explicit session row
<SessionHeader session={mySession} />`,
  },
  {
    id: 'session-timeline',
    label: 'Session Timeline',
    group: 'Components',
    pkg: 'session-timeline',
    description:
      'Scrollable per-turn timeline synchronized with the recording. Each turn is a band with STT, LLM, and TTS segments; hover to scrub, click to jump.',
    stage: 'stretch',
    render: () => (
      <StretchWrap>
        <SessionTimeline />
      </StretchWrap>
    ),
    props: [
      {
        name: 'metrics',
        type: 'SessionMetrics | null',
        description: 'Override per-turn metrics resolved from provider context.',
      },
      {
        name: 'recordUrl',
        type: 'string | null',
        description:
          'Recording URL. Override only when your audio URL does not ship with the session detail response.',
      },
      {
        name: 'onTurnClick',
        type: '(turnNumber: number) => void',
        description:
          'Handler for clicks on individual turn chips. Defaults to the provider’s setHighlightedTurn (which scrolls the transcript).',
      },
      {
        name: 'sessionCreatedAt',
        type: 'string',
        description:
          'ISO timestamp used to align the recording playback cursor with turn timestamps. Defaults to the session’s created_at.',
      },
    ],
    usage: `import { SessionTimeline } from '@/components/session-timeline/session-timeline'

<SessionTimeline />

// Custom turn-click handling (e.g. scroll a sibling panel)
<SessionTimeline onTurnClick={(n) => focusTurn(n)} />`,
  },
  {
    id: 'turn-transcript',
    label: 'Turn Transcript',
    group: 'Components',
    pkg: 'turn-transcript',
    description:
      'Two-column conversation transcript with per-turn metadata. Agent and user messages are paired; each pair links back to the corresponding timeline segment.',
    stage: 'stretch',
    render: () => (
      <StretchWrap>
        <TurnTranscriptSection />
      </StretchWrap>
    ),
    props: [
      {
        name: 'chatHistory',
        type: 'ChatItem[] | null',
        description:
          'Override the raw chat history resolved from provider context. Falls back to structured turn data from metrics when omitted.',
      },
      {
        name: 'metrics',
        type: 'SessionMetrics | null',
        description: 'Override the per-turn metrics resolved from provider context.',
      },
      {
        name: 'highlightedTurn',
        type: 'number | null',
        description:
          'Scrolls the matching turn into view when set. The provider updates this when users click turn chips in the timeline.',
      },
      {
        name: 'embedded',
        type: 'boolean',
        default: 'false',
        description:
          'Strips the outer card/header when embedding the transcript under another container (e.g. inside the session detail Session tab).',
      },
      {
        name: 'alignment',
        type: "'chat' | 'left'",
        default: "'chat'",
        description:
          '"chat" pairs user/agent messages across the column; "left" stacks both sides on the left for a log-style view.',
      },
    ],
    usage: `import { TurnTranscriptSection } from '@/components/turn-transcript'

// Default — chat-paired, context-driven
<TurnTranscriptSection />

// Embedded under a parent card, left-aligned log view
<TurnTranscriptSection embedded alignment="left" />`,
  },
  {
    id: 'session-events',
    label: 'Session Events',
    group: 'Components',
    pkg: 'session-events',
    description:
      'Chronological stream of raw pipeline events captured during the session — function calls, agent handoffs, state changes. Filterable by event type.',
    stage: 'stretch',
    render: () => (
      <StretchWrap>
        <SessionEvents />
      </StretchWrap>
    ),
    props: [
      {
        name: 'typeBadgeClass',
        type: 'Partial<Record<string, string>>',
        description:
          'Per-event-type Tailwind className overrides. Merged over the built-in defaults so you only need to specify the types you want to recolor.',
      },
      {
        name: 'fallbackBadgeClass',
        type: 'string',
        default: "'bg-muted text-muted-foreground'",
        description:
          'Fallback className used when an event type has no mapping in the defaults or overrides.',
      },
    ],
    usage: `import { SessionEvents } from '@/components/session-events'

// Default badge palette
<SessionEvents />

// Recolor a specific event type
<SessionEvents
  typeBadgeClass={{
    function_call: 'bg-orange-100 text-orange-800',
  }}
/>`,
  },
  {
    id: 'session-config',
    label: 'Session Config',
    group: 'Components',
    pkg: 'session-config',
    description:
      'Snapshot of the agent configuration used for the session: model IDs, voice settings, active tools, and any runtime options that shaped the conversation.',
    stage: 'stretch',
    render: () => (
      <StretchWrap>
        <SessionConfig />
      </StretchWrap>
    ),
    props: [],
    usage: `import { SessionConfig } from '@/components/session-config'

// No props — reads the options blob from provider context
;<SessionConfig />`,
  },

  {
    id: 'latency-percentiles',
    label: 'Latency Percentiles',
    group: 'Charts',
    pkg: 'latency-percentiles-chart',
    description:
      'Stacked bars showing p50 / p95 / p99 latency for each pipeline stage. Use to spot tail-latency offenders at a glance.',
    stage: 'stretch',
    render: () => (
      <StretchWrap>
        <LatencyPercentilesChart />
      </StretchWrap>
    ),
    props: [
      {
        name: 'metrics',
        type: 'SessionMetrics | null',
        description: 'Override the metrics resolved from provider context.',
      },
    ],
    usage: `import { LatencyPercentilesChart } from '@/components/latency-percentiles-chart'

;<LatencyPercentilesChart />`,
  },
  {
    id: 'pipeline-breakdown',
    label: 'Pipeline Breakdown',
    group: 'Charts',
    pkg: 'pipeline-breakdown-chart',
    description:
      'Per-turn pipeline breakdown — STT vs LLM vs TTS vs network. Makes it obvious which stage dominates end-to-end latency.',
    stage: 'stretch',
    render: () => (
      <StretchWrap>
        <PipelineBreakdownChart />
      </StretchWrap>
    ),
    props: [
      {
        name: 'metrics',
        type: 'SessionMetrics | null',
        description: 'Override the metrics resolved from provider context.',
      },
    ],
    usage: `import { PipelineBreakdownChart } from '@/components/pipeline-breakdown-chart'

;<PipelineBreakdownChart />`,
  },
  {
    id: 'latency-over-turns',
    label: 'Latency Over Turns',
    group: 'Charts',
    pkg: 'latency-over-turns-chart',
    description:
      'User-perceived latency plotted turn-by-turn. Reveals drift, warm-up effects, and the one bad turn that tanks the average.',
    stage: 'stretch',
    render: () => (
      <StretchWrap>
        <LatencyOverTurnsChart />
      </StretchWrap>
    ),
    props: [
      {
        name: 'metrics',
        type: 'SessionMetrics | null',
        description: 'Override the metrics resolved from provider context.',
      },
    ],
    usage: `import { LatencyOverTurnsChart } from '@/components/latency-over-turns-chart'

;<LatencyOverTurnsChart />`,
  },
  {
    id: 'token-usage',
    label: 'Token Usage',
    group: 'Charts',
    pkg: 'token-usage-section',
    description:
      'Per-turn input/output token counts with running totals. Designed to answer "is this conversation blowing the budget?" without a calculator.',
    stage: 'stretch',
    render: () => (
      <StretchWrap>
        <TokenUsageSection />
      </StretchWrap>
    ),
    props: [
      {
        name: 'metrics',
        type: 'SessionMetrics | null',
        description: 'Override the metrics resolved from provider context.',
      },
    ],
    usage: `import { TokenUsageSection } from '@/components/token-usage-section'

;<TokenUsageSection />`,
  },

  // ───── Utilities ─────────────────────────────────────────────────────
  {
    id: 'observability-chart-shared',
    label: 'Chart Shared',
    group: 'Utilities',
    pkg: 'observability-chart-shared',
    description:
      'Layout primitives for building additional charts that match the look of the built-in ones. Exports a ChartCard wrapper (title / subtitle / recharts container / legend row), a ChartTooltipShell for custom recharts tooltips, and a ChartLegendItem color-swatch row.',
    props: [
      {
        name: 'ChartCard.title',
        type: 'string',
        required: true,
        description: 'Card title shown at the top-left.',
      },
      {
        name: 'ChartCard.subtitle',
        type: 'string',
        description: 'Optional subtitle under the title.',
      },
      {
        name: 'ChartCard.legend',
        type: '{ color: string; label: string }[]',
        required: true,
        description:
          'Legend entries. Pass an empty array to suppress the legend row.',
      },
      {
        name: 'ChartCard.chartHeight',
        type: 'string',
        default: "'h-64'",
        description: 'Tailwind height class applied to the ResponsiveContainer wrapper.',
      },
      {
        name: 'ChartCard.children',
        type: 'React.ReactElement',
        required: true,
        description: 'A single recharts element (e.g. <BarChart>, <LineChart>).',
      },
      {
        name: 'ChartTooltipShell.active',
        type: 'boolean',
        description: 'Forwarded by recharts — the component renders nothing when false.',
      },
      {
        name: 'ChartTooltipShell.label',
        type: 'string | number',
        description: 'Axis label for the hovered point (rendered as "Turn {label}").',
      },
      {
        name: 'ChartTooltipShell.rows',
        type: '{ label: string; value: string; color?: string }[]',
        required: true,
        description:
          'Two-column key/value rows rendered inside the tooltip. Each row may override the label color.',
      },
      {
        name: 'ChartLegendItem.color',
        type: 'string',
        required: true,
        description: 'Any CSS color — used for the small square swatch.',
      },
      {
        name: 'ChartLegendItem.label',
        type: 'string',
        required: true,
        description: 'Legend text.',
      },
    ],
    usage: `import { Bar, BarChart, Tooltip, XAxis, YAxis } from 'recharts'
import {
  ChartCard,
  ChartTooltipShell,
} from '@/components/observability-chart-shared'

export function MyChart({ data }: { data: Row[] }) {
  return (
    <ChartCard
      title="My metric"
      subtitle="Per-turn trend"
      legend={[{ color: 'hsl(var(--primary))', label: 'Value' }]}
    >
      <BarChart data={data}>
        <XAxis dataKey="turn" />
        <YAxis />
        <Tooltip
          content={({ active, label, payload }) => (
            <ChartTooltipShell
              active={active}
              label={label}
              rows={(payload ?? []).map((p) => ({
                label: String(p.dataKey),
                value: String(p.value),
              }))}
            />
          )}
        />
        <Bar dataKey="value" fill="hsl(var(--primary))" />
      </BarChart>
    </ChartCard>
  )
}`,
  },
]

const GROUPS: Array<DocEntry['group']> = [
  'Core',
  'Hooks',
  'Pages',
  'Components',
  'Charts',
  'Utilities',
]

function PlivoLogo() {
  return (
    <svg
      viewBox="0 0 66 24"
      height="20"
      role="img"
      aria-label="Plivo"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M28.5501 6.05746C29.9177 6.05746 31.0264 4.90276 31.0264 3.47836C31.0264 2.05396 29.9177 0.899254 28.5501 0.899254C27.1824 0.899254 26.0737 2.05396 26.0737 3.47836C26.0737 4.90276 27.1824 6.05746 28.5501 6.05746Z" />
      <path d="M23.7103 22.3541V1.2623C23.7103 1.1527 23.6212 1.06022 23.5082 1.06022H19.3056C19.196 1.06022 19.1035 1.14927 19.1035 1.2623V22.3507C19.1035 22.4603 19.1926 22.5527 19.3056 22.5527H23.5082C23.6178 22.5527 23.7103 22.4637 23.7103 22.3507V22.3541ZM26.5771 22.5527H30.7797C30.8893 22.5527 30.9818 22.4637 30.9818 22.3507V7.70492C30.9818 7.59531 30.8927 7.50284 30.7797 7.50284H26.5771C26.4675 7.50284 26.375 7.59189 26.375 7.70492V22.3507C26.375 22.4603 26.4641 22.5527 26.5771 22.5527ZM43.9663 7.70834L40.9317 16.2848L37.9005 7.63984C37.8731 7.55764 37.7977 7.50626 37.7121 7.50626H33.0642C32.9204 7.50626 32.8245 7.65012 32.8793 7.7837L38.7876 22.4294C38.8184 22.5048 38.8903 22.5562 38.9725 22.5562H42.4148C42.4935 22.5562 42.5655 22.5082 42.5997 22.4363L49.0458 7.79055C49.104 7.65697 49.0081 7.50969 48.8608 7.50969H44.1855C44.0999 7.50969 44.0246 7.56449 43.9972 7.64327L43.9663 7.70834Z" />
      <path d="M42.4149 22.7309H38.9727C38.822 22.7309 38.685 22.6384 38.6233 22.4945L32.715 7.84879C32.6671 7.73234 32.6807 7.59876 32.7493 7.49601C32.8178 7.39325 32.9376 7.32818 33.0609 7.32818H37.7088C37.8698 7.32818 38.0136 7.43093 38.065 7.58163L40.9284 15.7505L43.8329 7.56451C43.8774 7.43093 44.0213 7.3316 44.1822 7.3316H48.8575C48.9877 7.3316 49.1041 7.39668 49.176 7.50286C49.2445 7.60903 49.2582 7.74261 49.2069 7.85907L42.7608 22.5048C42.6957 22.6452 42.5587 22.7309 42.4149 22.7309ZM33.0644 7.68439L33.0438 7.71864L38.9521 22.3644L42.4149 22.3815L48.8849 7.72206L48.8609 7.68781L44.1822 7.69809L44.1548 7.72206L44.1274 7.78029L40.9284 16.8191L37.7328 7.70151L33.0644 7.68439ZM30.7798 22.7274H26.5772C26.3683 22.7274 26.197 22.5562 26.197 22.3507V7.70494C26.197 7.49601 26.3683 7.32475 26.5772 7.32475H30.7798C30.9887 7.32475 31.1566 7.49601 31.1566 7.70494V22.3507C31.1566 22.5596 30.9853 22.7274 30.7798 22.7274ZM26.5772 7.67754C26.5772 7.67754 26.5498 7.68781 26.5498 7.70494V22.3507C26.5498 22.3507 26.5601 22.3781 26.5772 22.3781H30.7798C30.7798 22.3781 30.8038 22.3678 30.8038 22.3507V7.70494C30.8038 7.70494 30.7935 7.67754 30.7798 7.67754H26.5772ZM23.5083 22.7274H19.3057C19.0968 22.7274 18.9255 22.5562 18.9255 22.3507V1.26232C18.9255 1.05339 19.0968 0.882133 19.3057 0.882133H23.5083C23.7173 0.882133 23.8851 1.05339 23.8851 1.26232V22.3541C23.8851 22.5596 23.7138 22.7274 23.5083 22.7274ZM19.3057 1.23492C19.3057 1.23492 19.2783 1.24519 19.2783 1.26232V22.3507C19.2783 22.3507 19.2886 22.3781 19.3057 22.3781H23.5083C23.5083 22.3781 23.5323 22.3678 23.5323 22.3507V1.26232C23.5323 1.26232 23.522 1.23492 23.5083 1.23492H19.3057Z" />
      <path d="M6.4546 10.0443C5.93398 10.2464 5.40651 10.3799 4.95098 10.7225C4.25568 11.2465 3.9851 11.9658 3.72479 12.7672C3.69739 12.8049 3.62546 12.8049 3.60149 12.7672C3.40625 12.2466 3.26925 11.726 2.92674 11.2773C2.34447 10.5135 1.79303 10.421 0.964156 10.0854C0.899079 10.058 0.823727 10.0409 0.878528 9.94838C0.902504 9.90728 1.63548 9.66752 1.75193 9.61614C2.46778 9.31131 2.99182 8.78042 3.29665 8.06457C3.4131 7.78714 3.48846 7.48573 3.61176 7.21515L3.67341 7.1946L3.73849 7.2494C3.98167 8.02005 4.24883 8.70849 4.8996 9.22226C5.35514 9.58189 5.88945 9.72917 6.42377 9.92783C6.46487 9.9518 6.46145 10.0032 6.45117 10.0443H6.4546Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M4.28994 0.89241L6.01277 1.63223L16.3292 6.29722C16.3292 6.29722 16.3634 6.31435 16.3771 6.32462L16.4833 6.3897C16.6032 6.48903 16.8429 6.78016 16.8292 7.14322V12.4453C16.8224 12.6713 16.7162 13.1474 16.3737 13.3666C16.36 13.3803 16.3395 13.3906 16.3223 13.3975L8.79053 16.8739V22.3575C8.79053 22.5528 8.63297 22.7103 8.43774 22.7103H4.17691C3.98168 22.7103 3.82413 22.5528 3.82413 22.3575V14.1681C3.82413 14.1476 3.82413 14.127 3.82755 14.1099C3.83783 13.9832 3.93716 13.6886 4.24199 13.5105C4.25227 13.5036 4.26597 13.4968 4.27967 13.4899L12.1369 9.86618L3.85838 6.12939C3.7522 6.08144 3.70083 5.96841 3.7248 5.86223V5.68755L3.77275 1.66648C3.70768 1.00201 4.09129 0.87871 4.29337 0.89926V0.89241H4.28994Z" />
      <path d="M57.4577 6.94113C52.8167 6.94113 49.0559 10.5615 49.0559 15.0278C49.0559 19.4941 52.8167 23.1179 57.4577 23.1179C62.0987 23.1179 65.8595 19.4976 65.8595 15.0278C65.8595 10.558 62.0987 6.94113 57.4577 6.94113ZM57.4577 18.5077C55.6492 18.5077 54.1833 16.9493 54.1833 15.0278C54.1833 13.1063 55.6492 11.5479 57.4577 11.5479C59.2661 11.5479 60.7321 13.1063 60.7321 15.0278C60.7321 16.9493 59.2661 18.5077 57.4577 18.5077Z" />
    </svg>
  )
}

function DocsTopbar() {
  return (
    <header className="docs-topbar">
      <div className="brand-zone">
        <div className="brand">
          <PlivoLogo />
          <span className="divider">/</span>
          <span>agent-observability</span>
        </div>
      </div>
      <div className="main-zone">
        <nav>
          <a className="active">Components</a>
        </nav>
        <div className="spacer" />
        <a
          className="link-out"
          href="https://github.com/plivo-labs/agent-observability"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
        </a>
      </div>
    </header>
  )
}

function DocsSidebar({
  active,
  onSelect,
}: {
  active: string
  onSelect: (id: string) => void
}) {
  return (
    <aside className="docs-sidebar">
      {GROUPS.map((group) => (
        <div className="sect" key={group}>
          <div className="sect-h">{group}</div>
          {ENTRIES.filter((e) => e.group === group).map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={'item' + (entry.id === active ? ' active' : '')}
              onClick={() => onSelect(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      ))}
    </aside>
  )
}

function InstallBlock({ pkg }: { pkg: string }) {
  const [tab, setTab] = useState<'pnpm' | 'npm' | 'yarn' | 'bun'>('npm')
  const [copied, setCopied] = useState(false)
  const prefix: Record<typeof tab, string> = {
    pnpm: 'pnpm dlx',
    npm: 'npx',
    yarn: 'yarn dlx',
    bun: 'bunx --bun',
  }
  const command = `${prefix[tab]} agent-observability-ui@latest add ${pkg}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="install-block">
      <div className="install-tabs">
        {(['pnpm', 'npm', 'yarn', 'bun'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t ? 'active' : ''}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="install-cmd">
        <span className="prompt">$</span>
        <span className="cli">{prefix[tab]} agent-observability-ui@latest add </span>
        <span className="str">{pkg}</span>
        <button
          type="button"
          className="copy"
          onClick={copy}
          aria-label="Copy install command"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

// ─── Shiki syntax highlighter ──────────────────────────────────────────────
// Uses shiki/core + explicit grammar imports so the bundle only pays for
// tsx/ts + two themes (the default `shiki` entry registers every language).
// Dual-theme mode emits CSS variables (--shiki-light/-dark); docs.css flips
// them under .dark.

let highlighterPromise: Promise<HighlighterCore> | null = null
async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createOnigurumaEngine }] =
        await Promise.all([
          import('shiki/core'),
          import('shiki/engine/oniguruma'),
        ])
      return createHighlighterCore({
        themes: [
          import('shiki/themes/github-light.mjs'),
          import('shiki/themes/github-dark.mjs'),
        ],
        langs: [
          import('shiki/langs/tsx.mjs'),
          import('shiki/langs/typescript.mjs'),
        ],
        engine: createOnigurumaEngine(import('shiki/wasm')),
      })
    })()
  }
  return highlighterPromise
}

function CodeBlock({
  code,
  lang = 'tsx',
  className,
}: {
  code: string
  lang?: 'tsx' | 'ts'
  className?: string
}) {
  const [html, setHtml] = useState<string>('')
  useEffect(() => {
    let cancelled = false
    getHighlighter()
      .then((h) => {
        if (cancelled) return
        setHtml(
          h.codeToHtml(code, {
            lang,
            themes: { light: 'github-light', dark: 'github-dark' },
            defaultColor: false,
          }),
        )
      })
      .catch(() => {
        /* fall back to plain text */
      })
    return () => {
      cancelled = true
    }
  }, [code, lang])

  const cls = ['docs-code', className].filter(Boolean).join(' ')
  if (!html) {
    // Zero-shift placeholder while Shiki loads.
    return (
      <pre className={cls} aria-busy="true">
        <code>{code}</code>
      </pre>
    )
  }
  return <div className={cls} dangerouslySetInnerHTML={{ __html: html }} />
}

function PropsTable({ props: defs }: { props: PropDef[] }) {
  if (defs.length === 0) {
    return <p className="docs-empty">This component accepts no props.</p>
  }
  return (
    <div className="docs-props">
      <table>
        <thead>
          <tr>
            <th>Prop</th>
            <th>Type</th>
            <th>Default</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {defs.map((p) => (
            <tr key={p.name}>
              <td>
                <code>{p.name}</code>
                {p.required && <span className="req"> required</span>}
              </td>
              <td>
                <code className="type">{p.type}</code>
              </td>
              <td>
                {p.default ? (
                  <code className="dflt">{p.default}</code>
                ) : (
                  <span className="dash">—</span>
                )}
              </td>
              <td>{p.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function UsageBlock({ code, lang = 'tsx' }: { code: string; lang?: 'tsx' | 'ts' }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      /* noop — clipboard unavailable */
    }
  }
  return (
    <div className="docs-usage">
      <button type="button" className="copy" onClick={copy} aria-label="Copy code">
        {copied ? 'Copied' : 'Copy'}
      </button>
      <CodeBlock code={code} lang={lang} />
    </div>
  )
}

function Preview({
  stage = 'centered',
  children,
}: {
  stage?: Stage
  children: React.ReactNode
}) {
  return (
    <div className="pvw">
      <div className="pvw-tabs">
        <button type="button" className="active">
          Preview
        </button>
        <span className="grow" />
      </div>
      <div
        className={
          'pvw-stage' +
          (stage === 'left' ? ' left' : stage === 'stretch' ? ' stretch' : '')
        }
      >
        {children}
      </div>
    </div>
  )
}

function DocsPage() {
  const { entryId } = useParams<{ entryId: string }>()
  const navigate = useNavigate()

  const active = useMemo(
    () => ENTRIES.find((e) => e.id === entryId) ?? ENTRIES[0],
    [entryId],
  )
  const index = ENTRIES.findIndex((e) => e.id === active.id)
  const prev = index > 0 ? ENTRIES[index - 1] : null
  const next = index < ENTRIES.length - 1 ? ENTRIES[index + 1] : null

  const select = (id: string) => navigate(`/${id}`)

  return (
    <div className="docs-shell">
      <DocsTopbar />
      <DocsSidebar active={active.id} onSelect={select} />
      <main className="docs-main">
        <div className="docs-crumbs">
          <span>{active.group}</span>
          <span className="sep"> / </span>
          <span className="cur">{active.label}</span>
        </div>
        <h1>{active.label}</h1>
        <p className="lede">{active.description}</p>

        {active.render && (
          <>
            <div className="comp-sub">Preview</div>
            <Preview stage={active.stage}>{active.render()}</Preview>
          </>
        )}

        {active.signature && (
          <>
            <div className="comp-sub">Signature</div>
            <CodeBlock code={active.signature} lang="ts" className="docs-signature" />
          </>
        )}

        <div className="comp-sub">Installation</div>
        <InstallBlock pkg={active.pkg} />

        {active.usage && (
          <>
            <div className="comp-sub">Usage</div>
            <UsageBlock code={active.usage} />
          </>
        )}

        {active.props && (
          <>
            <div className="comp-sub">
              {active.group === 'Hooks' ? 'Parameters' : 'Props'}
            </div>
            <PropsTable props={active.props} />
          </>
        )}

        {active.returns && (
          <>
            <div className="comp-sub">Returns</div>
            <CodeBlock code={active.returns} lang="ts" className="docs-signature" />
          </>
        )}

        <div className="docs-pager">
          <button
            type="button"
            disabled={!prev}
            onClick={() => prev && select(prev.id)}
          >
            <span className="dir">Previous</span>
            <span className="tt">{prev ? prev.label : '—'}</span>
          </button>
          <button
            type="button"
            className="next"
            disabled={!next}
            onClick={() => next && select(next.id)}
          >
            <span className="dir">Next</span>
            <span className="tt">{next ? next.label : '—'}</span>
          </button>
        </div>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <AgentObservabilityProvider baseUrl="/api" sessionId={SESSION_ID}>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <Routes>
          <Route path="/" element={<Navigate to={`/${ENTRIES[0].id}`} replace />} />
          <Route path="/:entryId" element={<DocsPage />} />
          <Route path="*" element={<Navigate to={`/${ENTRIES[0].id}`} replace />} />
        </Routes>
      </BrowserRouter>
    </AgentObservabilityProvider>
  )
}
