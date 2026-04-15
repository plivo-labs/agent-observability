import { useState } from 'react'
import { MemoryRouter, Routes, Route, useNavigate, useParams } from 'react-router'
import { AgentObservabilityProvider } from '@/lib/observability-provider'
import { MetricSummaryCards } from '@/components/metric-summary-cards'
import { LatencyPercentilesChart } from '@/components/latency-percentiles-chart'
import { PipelineBreakdownChart } from '@/components/pipeline-breakdown-chart'
import { LatencyOverTurnsChart } from '@/components/latency-over-turns-chart'
import { TokenUsageSection } from '@/components/token-usage-section'
import { SessionHeader } from '@/components/session-header'
import { TurnTranscriptSection } from '@/components/turn-transcript'
import { SessionTimeline } from '@/components/session-timeline/session-timeline'
import { SessionsPage } from '@/components/sessions-page'
import { SessionDetailPage } from '@/components/session-detail-page'
import mockData from './mock-data.json'

const SESSION_ID = mockData.sessions[0].session_id

type View =
  | 'all'
  | 'sessions-page'
  | 'session-detail-page'
  | 'metric-summary-cards'
  | 'session-header'
  | 'session-timeline'
  | 'turn-transcript'
  | 'latency-percentiles'
  | 'pipeline-breakdown'
  | 'latency-over-turns'
  | 'token-usage'

interface NavItem {
  key: View
  label: string
  group: string
}

const NAV: NavItem[] = [
  { key: 'all', label: 'All Components', group: 'Overview' },
  { key: 'sessions-page', label: 'Sessions List', group: 'Pages' },
  { key: 'session-detail-page', label: 'Session Detail', group: 'Pages' },
  { key: 'metric-summary-cards', label: 'Metric Summary Cards', group: 'Components' },
  { key: 'session-header', label: 'Session Header', group: 'Components' },
  { key: 'session-timeline', label: 'Session Timeline', group: 'Components' },
  { key: 'turn-transcript', label: 'Turn Transcript', group: 'Components' },
  { key: 'latency-percentiles', label: 'Latency Percentiles', group: 'Charts' },
  { key: 'pipeline-breakdown', label: 'Pipeline Breakdown', group: 'Charts' },
  { key: 'latency-over-turns', label: 'Latency Over Turns', group: 'Charts' },
  { key: 'token-usage', label: 'Token Usage', group: 'Charts' },
]

const groups = [...new Set(NAV.map((n) => n.group))]

function ComponentSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h3 className="text-s-600 font-medium text-muted-foreground mb-3">{title}</h3>
      {children}
    </div>
  )
}

function AllComponents() {
  return (
    <div className="p-6 space-y-6">
      <ComponentSection title="Metric Summary Cards">
        <MetricSummaryCards />
      </ComponentSection>
      <ComponentSection title="Session Header">
        <SessionHeader />
      </ComponentSection>
      <h3 className="text-s-600 font-medium text-muted-foreground">Performance Charts</h3>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <LatencyPercentilesChart />
        <PipelineBreakdownChart />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <LatencyOverTurnsChart />
        <TokenUsageSection />
      </div>
      <ComponentSection title="Session Timeline">
        <SessionTimeline />
      </ComponentSection>
      <ComponentSection title="Turn Transcript">
        <TurnTranscriptSection />
      </ComponentSection>
    </div>
  )
}

/** Preview wrappers that wire up navigation callbacks */

function SessionsListRoute() {
  const navigate = useNavigate()
  return <SessionsPage onSessionClick={(id) => navigate(`/sessions/${id}`)} />
}

function SessionDetailRoute() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  return (
    <AgentObservabilityProvider baseUrl="/api" sessionId={sessionId}>
      <SessionDetailPage onBack={() => navigate('/')} />
    </AgentObservabilityProvider>
  )
}

function SessionsListPreview() {
  return (
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<SessionsListRoute />} />
        <Route path="/sessions/:sessionId" element={<SessionDetailRoute />} />
      </Routes>
    </MemoryRouter>
  )
}

function SessionDetailPreview() {
  return (
    <MemoryRouter initialEntries={[`/sessions/${SESSION_ID}`]}>
      <Routes>
        <Route path="/" element={<SessionsListRoute />} />
        <Route path="/sessions/:sessionId" element={<SessionDetailRoute />} />
      </Routes>
    </MemoryRouter>
  )
}

function SingleComponent({ view }: { view: View }) {
  switch (view) {
    case 'sessions-page':
      return <SessionsListPreview />
    case 'session-detail-page':
      return <SessionDetailPreview />
    default:
      break
  }

  const components: Record<string, React.ReactNode> = {
    'metric-summary-cards': <MetricSummaryCards />,
    'session-header': <SessionHeader />,
    'session-timeline': <SessionTimeline />,
    'turn-transcript': <TurnTranscriptSection />,
    'latency-percentiles': <LatencyPercentilesChart />,
    'pipeline-breakdown': <PipelineBreakdownChart />,
    'latency-over-turns': <LatencyOverTurnsChart />,
    'token-usage': <TokenUsageSection />,
  }
  return <div className="p-6">{components[view]}</div>
}

export default function App() {
  const [view, setView] = useState<View>('all')

  return (
    <AgentObservabilityProvider baseUrl="/api" sessionId={SESSION_ID}>
      <div className="flex h-screen">
        <aside className="w-56 shrink-0 border-r bg-card overflow-y-auto">
          <div className="px-4 py-4 border-b">
            <h1 className="text-p-600 font-semibold">Agent Observability</h1>
            <p className="text-xs text-muted-foreground mt-0.5">UI Preview</p>
          </div>
          <nav className="p-2">
            {groups.map((group) => (
              <div key={group} className="mb-3">
                <span className="px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {group}
                </span>
                <div className="mt-1 flex flex-col gap-0.5">
                  {NAV.filter((n) => n.group === group).map((item) => (
                    <button
                      key={item.key}
                      onClick={() => setView(item.key)}
                      className={[
                        'w-full text-left px-2 py-1.5 rounded text-s-400 transition-colors',
                        view === item.key
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'text-muted-foreground hover:text-foreground hover:bg-accent',
                      ].join(' ')}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <main className="flex-1 overflow-y-auto bg-background">
          <div className="border-b px-6 py-3">
            <h2 className="text-p-400 font-medium">
              {NAV.find((n) => n.key === view)?.label}
            </h2>
          </div>
          {view === 'all' ? <AllComponents /> : <SingleComponent view={view} />}
        </main>
      </div>
    </AgentObservabilityProvider>
  )
}
