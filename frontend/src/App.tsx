import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Link, useLocation, useParams, useNavigate } from 'react-router'
import { NuqsAdapter } from 'nuqs/adapters/react-router/v7'
import { Activity, CalendarClock, CheckCheck, FlaskConical, Library, List, Moon, Phone, RefreshCw, Sun } from 'lucide-react'
import { AgentObservabilityProvider } from './lib/observability-provider'
import { SessionsPage } from '@/components/sessions-page'
import { SimulatePage } from '@/components/simulate/simulate-page'
import { LiveCallPage } from '@/components/live/live-call-page'
import { LibraryPage } from '@/components/library/library-page'
import { SchedulesPage } from '@/components/schedules/schedules-page'
import { SessionDetailPage } from '@/components/session-detail-page'
import { EvalsPage } from '@/components/evals-page'
import { EvalRunDetailPage } from '@/components/eval-run-detail-page'
import { EvalCaseDetailPage } from '@/components/eval-case-detail-page'
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
  const isSimulateActive = pathname.startsWith('/simulate')
  const isLiveActive = pathname.startsWith('/live')
  const isEvalsActive = pathname.startsWith('/evals')
  const isLibraryActive = pathname.startsWith('/library')
  const isSchedulesActive = pathname.startsWith('/schedules')

  return (
    <div className="obs-app">
      <nav className="obs-nav">
        <Link to="/" className="obs-nav-brand">
          <span className="dot"><Activity size={13} strokeWidth={2} /></span>
          Agent Observability
        </Link>
        <div className="obs-nav-tabs">
          <Link to="/" className={`obs-tab${isSessionsActive ? ' active' : ''}`}>
            <List size={14} /> Monitor
          </Link>
          <Link to="/simulate" className={`obs-tab${isSimulateActive ? ' active' : ''}`}>
            <FlaskConical size={14} /> Simulate
          </Link>
          <Link to="/live" className={`obs-tab${isLiveActive ? ' active' : ''}`}>
            <Phone size={14} /> Live
          </Link>
          <Link to="/evals" className={`obs-tab${isEvalsActive ? ' active' : ''}`}>
            <CheckCheck size={14} /> Evals
          </Link>
          <Link to="/library" className={`obs-tab${isLibraryActive ? ' active' : ''}`}>
            <Library size={14} /> Library
          </Link>
          <Link to="/schedules" className={`obs-tab${isSchedulesActive ? ' active' : ''}`}>
            <CalendarClock size={14} /> Schedules
          </Link>
        </div>
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
  // No onCaseClick → EvalRunDetailPage opens a drawer (URL-synced via ?case=<id>).
  return (
    <EvalRunDetailPage
      runId={runId}
      onBack={() => navigate('/evals')}
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
      <NuqsAdapter>
        <Layout>
          <AgentObservabilityProvider baseUrl="/api">
            <Routes>
              <Route path="/" element={<SessionsRoute />} />
              <Route path="/simulate" element={<SimulatePage />} />
              <Route path="/live" element={<LiveCallPage />} />
              <Route path="/sessions/:sessionId" element={<SessionDetailRoute />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/schedules" element={<SchedulesPage />} />
              <Route path="/evals" element={<EvalsRoute />} />
              <Route path="/evals/:runId" element={<EvalRunDetailRoute />} />
              <Route path="/evals/:runId/cases/:caseId" element={<EvalCaseDetailRoute />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </AgentObservabilityProvider>
        </Layout>
      </NuqsAdapter>
    </BrowserRouter>
  )
}
