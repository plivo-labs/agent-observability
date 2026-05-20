import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Link, useLocation, useParams, useNavigate } from 'react-router'
import { NuqsAdapter } from 'nuqs/adapters/react-router/v7'
import { Activity, Moon, RefreshCw, Sun } from 'lucide-react'
import { AgentObservabilityProvider } from './lib/observability-provider'
import { SessionDetailPage } from '@/components/session-detail-page'
import { EvalRunDetailPage } from '@/components/eval-run-detail-page'
import { EvalCaseDetailPage } from '@/components/eval-case-detail-page'
import { EvalRunComparePage } from '@/components/eval-run-compare-page'
import { AgentsPage } from '@/components/agents-page'
import { AgentDetailPage } from '@/components/agent-detail-page'
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

  return (
    <div className="obs-app">
      <nav className="obs-nav">
        <Link to="/" className="obs-nav-brand">
          <span className="dot"><Activity size={13} strokeWidth={2} /></span>
          Agent Observability
        </Link>
        <div className="obs-nav-spacer" />
        <div className="obs-nav-right">
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

function AgentsRoute() {
  const navigate = useNavigate()
  return (
    <AgentsPage
      onAgentClick={(id) => navigate(`/agents/${encodeURIComponent(id)}`)}
    />
  )
}

function AgentDetailRoute() {
  const { agentId } = useParams<{ agentId: string }>()
  const navigate = useNavigate()
  if (!agentId) return null
  // URL carries only the agent_id. When the same agent_id exists under
  // multiple accounts (rare; only when agent_ids are slugs rather than
  // UUIDs), the server returns the most-recently-active row.
  const encoded = encodeURIComponent(decodeURIComponent(agentId))
  return (
    <AgentDetailPage
      agentId={decodeURIComponent(agentId)}
      onSessionClick={(id) => navigate(`/agents/${encoded}/sessions/${id}`)}
      onRunClick={(runId) => navigate(`/agents/${encoded}/simulation-evals/${runId}`)}
      onCompare={(runIdA, runIdB) =>
        navigate(`/agents/${encoded}/simulation-evals/compare?runA=${runIdA}&runB=${runIdB}`)
      }
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
  const decoded = decodeURIComponent(agentId)
  const encoded = encodeURIComponent(decoded)
  return (
    <EvalRunComparePage
      agentId={decoded}
      runIdA={runIdA}
      runIdB={runIdB}
      onOpenRun={(runId) => navigate(`/agents/${encoded}/simulation-evals/${runId}`)}
    />
  )
}

function SessionDetailRoute() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const decoded = sessionId ? decodeURIComponent(sessionId) : undefined
  return (
    <AgentObservabilityProvider baseUrl="/api" sessionId={decoded}>
      <SessionDetailPage />
    </AgentObservabilityProvider>
  )
}

function EvalRunDetailRoute() {
  const { runId } = useParams<{ runId: string }>()
  if (!runId) return null
  // No onCaseClick → EvalRunDetailPage opens a drawer (URL-synced via ?case=<id>).
  return (
    <EvalRunDetailPage runId={runId} />
  )
}

function EvalCaseDetailRoute() {
  const { agentId, runId, caseId } = useParams<{ agentId: string; runId: string; caseId: string }>()
  const navigate = useNavigate()
  if (!agentId || !runId || !caseId) return null
  return (
    <EvalCaseDetailPage
      runId={runId}
      caseId={caseId}
      onBack={() => navigate(`/agents/${encodeURIComponent(agentId)}/simulation-evals/${runId}`)}
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
              <Route path="/" element={<AgentsRoute />} />
              <Route path="/agents" element={<AgentsRoute />} />
              <Route path="/agents/:agentId" element={<AgentDetailRoute />} />
              <Route path="/agents/:agentId/sessions/:sessionId" element={<SessionDetailRoute />} />
              <Route path="/agents/:agentId/simulation-evals/compare" element={<EvalRunCompareRoute />} />
              <Route path="/agents/:agentId/simulation-evals/:runId" element={<EvalRunDetailRoute />} />
              <Route path="/agents/:agentId/simulation-evals/:runId/cases/:caseId" element={<EvalCaseDetailRoute />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </AgentObservabilityProvider>
        </Layout>
      </NuqsAdapter>
    </BrowserRouter>
  )
}
