import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Link, useLocation, useParams, useNavigate } from 'react-router'
import { NuqsAdapter } from 'nuqs/adapters/react-router/v7'
import { Activity, CheckCheck, List, Moon, RefreshCw, Search, Sun, Zap } from 'lucide-react'
import { AgentObservabilityProvider } from './lib/observability-provider'
import { SessionsPage } from '@/components/sessions-page'
import { SessionDetailPage } from '@/components/session-detail-page'
import { AgentsPage } from '@/components/agents-page'
import { AgentRunsPage } from '@/components/agent-runs-page'
import { EvalRunDetailPage } from '@/components/eval-run-detail-page'
import { EvalRunComparePage } from '@/components/eval-run-compare-page'
import { EvalCaseDetailPage } from '@/components/eval-case-detail-page'
import { ActivityPage } from '@/components/activity-page'
import { NotFoundPage } from '@/components/not-found-page'

const useDarkMode = () => {
  const [dark, setDark] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('darkMode') === 'true'
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('darkMode', String(dark))
  }, [dark])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
        e.preventDefault()
        setDark((d) => !d)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return [dark, () => setDark((d) => !d)] as const
}

const Layout = ({ children }: { children: React.ReactNode }) => {
  const [dark, toggleDark] = useDarkMode()
  const { pathname } = useLocation()

  // NavLink's `end` prop scopes the active match to a single path, so the
  // Sessions tab (at `/`) would lose its highlight on `/sessions/:id`. Compute
  // active state ourselves: each tab claims its detail routes too.
  const isSessionsActive = pathname === '/' || pathname.startsWith('/sessions')
  const isActivityActive = pathname.startsWith('/activity')
  const isEvalsActive = pathname.startsWith('/evals') && !isActivityActive

  return (
    <div className="obs-app">
      <nav className="obs-nav">
        <Link to="/" className="obs-nav-brand">
          <span className="dot"><Activity size={13} strokeWidth={2} /></span>
          Agent Observability
        </Link>
        <div className="obs-nav-tabs">
          <Link to="/" className={`obs-tab${isSessionsActive ? ' active' : ''}`}>
            <List size={14} /> Sessions
          </Link>
          <Link to="/evals" className={`obs-tab${isEvalsActive ? ' active' : ''}`}>
            <CheckCheck size={14} /> Evals
          </Link>
          <Link to="/activity" className={`obs-tab${isActivityActive ? ' active' : ''}`}>
            <Zap size={14} /> Activity
          </Link>
        </div>
        <div className="obs-nav-spacer" />
        <div className="obs-nav-right">
          <button type="button" className="obs-cmdk">
            <Search size={14} />
            <span>Search agents, runs, cases...</span>
            <span className="obs-kbd">⌘K</span>
          </button>
          <button
            type="button"
            className="obs-iconbtn"
            title="Refresh"
            onClick={() => window.location.reload()}
          >
            <RefreshCw size={16} />
          </button>
          <button
            type="button"
            className="obs-iconbtn"
            onClick={toggleDark}
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </nav>
      <main className="obs-main">
        <div className="obs-page">{children}</div>
      </main>
    </div>
  )
}

function ActivityRoute() {
  const navigate = useNavigate()
  return (
    <ActivityPage
      onOpenRun={(_agentId, runId) => navigate(`/evals/runs/${runId}`)}
      onOpenAgent={(agentId) => navigate(`/evals/agents/${encodeURIComponent(agentId)}`)}
    />
  )
}

function SessionsRoute() {
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

function AgentsRoute() {
  const navigate = useNavigate()
  return (
    <AgentsPage
      onAgentClick={(agentId) => navigate(`/evals/agents/${encodeURIComponent(agentId)}`)}
    />
  )
}

function AgentRunsRoute() {
  const { agentId } = useParams<{ agentId: string }>()
  const navigate = useNavigate()
  if (!agentId) return null
  return (
    <AgentRunsPage
      agentId={decodeURIComponent(agentId)}
      onBack={() => navigate('/evals')}
      onRunClick={(runId) => navigate(`/evals/runs/${runId}`)}
      onCompare={(runIdA, runIdB) => {
        const encodedAgentId = encodeURIComponent(decodeURIComponent(agentId))
        navigate(`/evals/agents/${encodedAgentId}/compare?runA=${runIdA}&runB=${runIdB}`)
      }}
    />
  )
}

function EvalRunCompareRoute() {
  const { agentId } = useParams<{ agentId: string }>()
  const navigate = useNavigate()
  const params = new URLSearchParams(useLocation().search)
  const runIdA = params.get('runA') ?? undefined
  const runIdB = params.get('runB') ?? undefined
  if (!agentId) return null
  return (
    <EvalRunComparePage
      agentId={decodeURIComponent(agentId)}
      runIdA={runIdA}
      runIdB={runIdB}
      onBack={() => navigate(`/evals/agents/${agentId}`)}
      onOpenRun={(runId) => navigate(`/evals/runs/${runId}`)}
    />
  )
}

function EvalRunDetailRoute() {
  const { runId } = useParams<{ runId: string }>()
  const navigate = useNavigate()
  if (!runId) return null
  // No onCaseClick → EvalRunDetailPage opens a drawer (URL-synced via ?case=<id>).
  return (
    <EvalRunDetailPage
      runId={runId}
      onBack={() => navigate(-1)}
    />
  )
}

function EvalCaseDetailRoute() {
  const { runId, caseId } = useParams<{ runId: string; caseId: string }>()
  const navigate = useNavigate()
  if (!runId || !caseId) return null
  return (
    <EvalCaseDetailPage
      runId={runId}
      caseId={caseId}
      onBack={() => navigate(`/evals/runs/${runId}`)}
    />
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <NuqsAdapter>
        <Layout>
          <AgentObservabilityProvider baseUrl="/api">
            <Routes>
              <Route path="/" element={<SessionsRoute />} />
              <Route path="/sessions/:sessionId" element={<SessionDetailRoute />} />
              <Route path="/evals" element={<AgentsRoute />} />
              <Route path="/evals/agents/:agentId" element={<AgentRunsRoute />} />
              <Route path="/evals/agents/:agentId/compare" element={<EvalRunCompareRoute />} />
              <Route path="/evals/runs/:runId" element={<EvalRunDetailRoute />} />
              <Route path="/evals/runs/:runId/cases/:caseId" element={<EvalCaseDetailRoute />} />
              <Route path="/activity" element={<ActivityRoute />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </AgentObservabilityProvider>
        </Layout>
      </NuqsAdapter>
    </BrowserRouter>
  )
}
