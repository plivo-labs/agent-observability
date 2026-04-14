import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Link } from 'react-router'
import { Moon, Sun } from 'lucide-react'
import { SessionsPage } from './pages/sessions'
import { SessionDetailPage } from './pages/session-detail'

const useDarkMode = () => {
  const [dark, setDark] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('darkMode') === 'true'
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('darkMode', String(dark))
  }, [dark])

  // Cmd+D / Ctrl+D shortcut (matches console behavior)
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

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<SessionsPage />} />
          <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  )
}
