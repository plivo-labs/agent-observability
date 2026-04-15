import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { createObservabilityApi, type ObservabilityApi } from '@/lib/observability-api'
import type { AgentSessionRow } from '@/lib/observability-types'

interface ObservabilityContextValue {
  api: ObservabilityApi
  session: AgentSessionRow | null
  sessionLoading: boolean
  sessionError: string | null
  highlightedTurn: number | null
  setHighlightedTurn: (turn: number | null) => void
}

const ObservabilityContext = createContext<ObservabilityContextValue | null>(null)

export function AgentObservabilityProvider({
  baseUrl,
  sessionId,
  children,
}: {
  baseUrl: string
  sessionId?: string
  children: ReactNode
}) {
  const api = useMemo(() => createObservabilityApi(baseUrl), [baseUrl])
  const [session, setSession] = useState<AgentSessionRow | null>(null)
  const [sessionLoading, setSessionLoading] = useState(!!sessionId)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [highlightedTurn, setHighlightedTurn] = useState<number | null>(null)

  useEffect(() => {
    if (!sessionId) {
      setSession(null)
      setSessionLoading(false)
      return
    }
    setSessionLoading(true)
    setSessionError(null)
    api
      .getSession(sessionId)
      .then(setSession)
      .catch((e) => setSessionError(e.message))
      .finally(() => setSessionLoading(false))
  }, [api, sessionId])

  const value = useMemo<ObservabilityContextValue>(
    () => ({
      api,
      session,
      sessionLoading,
      sessionError,
      highlightedTurn,
      setHighlightedTurn,
    }),
    [api, session, sessionLoading, sessionError, highlightedTurn],
  )

  return (
    <ObservabilityContext.Provider value={value}>
      {children}
    </ObservabilityContext.Provider>
  )
}

export function useObservabilityContext() {
  const ctx = useContext(ObservabilityContext)
  if (!ctx) {
    throw new Error('useObservabilityContext must be used within AgentObservabilityProvider')
  }
  return ctx
}
