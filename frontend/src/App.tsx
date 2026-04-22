import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Link, NavLink, useParams, useNavigate } from 'react-router'
import { Moon, Sun } from 'lucide-react'
import { AgentObservabilityProvider } from './lib/observability-provider'
import { SessionsPage } from '@/components/sessions-page'
import { SessionDetailPage } from '@/components/session-detail-page'
import { EvalsPage } from '@/components/evals-page'
import { EvalRunDetailPage } from '@/components/eval-run-detail-page'
import { EvalCaseDetailPage } from '@/components/eval-case-detail-page'

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

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `text-s-500 px-3 py-1.5 rounded-md transition-colors ${
      isActive
        ? 'bg-accent text-foreground'
        : 'text-muted-foreground hover:text-foreground hover:bg-accent/40'
    }`

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link to="/" className="text-h4-600 font-semibold text-foreground hover:text-primary transition-colors">
            Agent Observability
          </Link>
          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={navLinkClass}>
              Sessions
            </NavLink>
            <NavLink to="/evals" className={navLinkClass}>
              Evals
            </NavLink>
          </nav>
        </div>
        <button
          type="button"
          onClick={toggleDark}
          className="flex h-8 w-8 items-center justify-center rounded-md border bg-background hover:bg-accent transition-colors"
          title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {dark ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </header>
      <main>{children}</main>
    </div>
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

function EvalsRoute() {
  const navigate = useNavigate()
  return <EvalsPage onRunClick={(runId) => navigate(`/evals/${runId}`)} />
}

function EvalRunDetailRoute() {
  const { runId } = useParams<{ runId: string }>()
  const navigate = useNavigate()
  if (!runId) return null
  return (
    <EvalRunDetailPage
      runId={runId}
      onBack={() => navigate('/evals')}
      onCaseClick={(caseId) => navigate(`/evals/${runId}/cases/${caseId}`)}
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
      onBack={() => navigate(`/evals/${runId}`)}
    />
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <AgentObservabilityProvider baseUrl="/api">
          <Routes>
            <Route path="/" element={<SessionsRoute />} />
            <Route path="/sessions/:sessionId" element={<SessionDetailRoute />} />
            <Route path="/evals" element={<EvalsRoute />} />
            <Route path="/evals/:runId" element={<EvalRunDetailRoute />} />
            <Route path="/evals/:runId/cases/:caseId" element={<EvalCaseDetailRoute />} />
          </Routes>
        </AgentObservabilityProvider>
      </Layout>
    </BrowserRouter>
  )
}
