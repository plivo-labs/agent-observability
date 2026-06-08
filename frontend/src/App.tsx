import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Link, useLocation, useParams, useNavigate } from 'react-router'
import { NuqsAdapter } from 'nuqs/adapters/react-router/v7'
import { Activity, CalendarClock, CheckCheck, FlaskConical, Library, List, Moon, RefreshCw, Sun } from 'lucide-react'
import { AgentObservabilityProvider } from './lib/observability-provider'
import { SessionsPage } from '@/components/sessions-page'
import { SimulatePage } from '@/components/simulate/simulate-page'
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
  const isEvalsActive = pathname.startsWith('/evals')
  const isLibraryActive = pathname.startsWith('/library')
  const isSchedulesActive = pathname.startsWith('/schedules')

  const NavLink = ({ to, active, icon, label }: { to: string; active: boolean; icon: React.ReactNode; label: string }) => (
    <Link to={to} className={`obs-side-link${active ? ' active' : ''}`}>
      {icon}<span className="obs-side-linktext">{label}</span>
    </Link>
  )

  return (
    <div className="obs-app">
      <aside className="obs-side">
        <Link to="/" className="obs-side-brand">
          <span className="dot"><Activity size={15} strokeWidth={2} /></span>
          <span className="obs-side-brandtext">Agent<br />Observability</span>
        </Link>
        <nav className="obs-side-nav">
          <div className="obs-side-group">
            <div className="obs-side-grouplabel">Observe</div>
            <NavLink to="/" active={isSessionsActive} icon={<List size={16} />} label="Monitor" />
            <NavLink to="/evals" active={isEvalsActive} icon={<CheckCheck size={16} />} label="Evals" />
          </div>
          <div className="obs-side-group">
            <div className="obs-side-grouplabel">Test</div>
            <NavLink to="/simulate" active={isSimulateActive} icon={<FlaskConical size={16} />} label="Simulate" />
          </div>
          <div className="obs-side-group">
            <div className="obs-side-grouplabel">Configure</div>
            <NavLink to="/library" active={isLibraryActive} icon={<Library size={16} />} label="Library" />
            <NavLink to="/schedules" active={isSchedulesActive} icon={<CalendarClock size={16} />} label="Schedules" />
          </div>
        </nav>
        <div className="obs-side-foot">
          <button type="button" className="obs-iconbtn" title="Refresh" onClick={() => window.location.reload()}>
            <RefreshCw size={16} />
          </button>
          <button type="button" className="obs-iconbtn" onClick={toggleDark} title={dark ? 'Switch to light mode' : 'Switch to dark mode'}>
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </aside>
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
