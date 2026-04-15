import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Link, useParams, useNavigate } from 'react-router'
import { Moon, Sun } from 'lucide-react'
import { AgentObservabilityProvider } from './lib/observability-provider'
import { SessionsPage } from '@/components/sessions-page'
import { SessionDetailPage } from '@/components/session-detail-page'

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
    <div className="min-h-screen bg-background">
      <header className="border-b px-6 py-3 flex items-center justify-between">
        <Link to="/" className="text-h4-600 font-semibold text-foreground hover:text-primary transition-colors">
          Agent Observability
        </Link>
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

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <AgentObservabilityProvider baseUrl="/api">
          <Routes>
            <Route path="/" element={<SessionsRoute />} />
            <Route path="/sessions/:sessionId" element={<SessionDetailRoute />} />
          </Routes>
        </AgentObservabilityProvider>
      </Layout>
    </BrowserRouter>
  )
}
