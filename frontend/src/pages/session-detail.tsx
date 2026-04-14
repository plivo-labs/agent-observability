import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router'
import { AudioLines, BarChart3, ChevronRight, Settings } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import type { AgentSessionRow } from '@/lib/types'
import { MetricSummaryCards } from '@/components/charts/metric-summary-cards'
import { LatencyPercentilesChart } from '@/components/charts/latency-percentiles-chart'
import { PipelineBreakdownChart } from '@/components/charts/pipeline-breakdown-chart'
import { LatencyOverTurnsChart } from '@/components/charts/latency-over-turns-chart'
import { TokenUsageSection } from '@/components/charts/token-usage-section'
import { TalkTimeChart } from '@/components/charts/talk-time-chart'
import { CacheEfficiencyChart } from '@/components/charts/cache-efficiency-chart'
import { LlmThroughputChart } from '@/components/charts/llm-throughput-chart'
import { TurnTranscriptSection } from '@/components/turn-transcript'
import { SessionHeader } from '@/components/session-header'
import { SessionTimeline } from '@/components/session-timeline'

export const SessionDetailPage = () => {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const [session, setSession] = useState<AgentSessionRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [highlightedTurn, setHighlightedTurn] = useState<number | null>(null)

  useEffect(() => {
    if (!sessionId) return

    setLoading(true)
    api.getSession(sessionId)
      .then(setSession)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [sessionId])

  const metrics = session?.session_metrics ?? null

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          <span className="text-s-400">Loading session details...</span>
        </div>
      </div>
    )
  }

  if (error || !session) {
    return (
      <div className="p-12 text-center text-destructive">
        <p>{error ?? 'Session not found'}</p>
      </div>
    )
  }

  const turnCount = metrics?.turns?.length ?? session.turn_count ?? 0

  return (
    <ScrollArea className="h-[calc(100vh-53px)]">
      <div className="flex flex-col gap-5 p-6">
        <nav className="flex items-center gap-1.5 text-s-400">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors bg-transparent border-none p-0 text-s-400"
            onClick={() => navigate('/')}
          >
            Sessions
          </button>
          <ChevronRight size={14} className="text-muted-foreground/60" />
          <span className="font-mono truncate max-w-[300px]">{session.session_id}</span>
        </nav>

        <SessionHeader session={session} />
        <MetricSummaryCards metrics={metrics} />

        <Tabs defaultValue="session" className="w-full">
          <TabsList className="sticky top-0 bg-background z-10">
            <TabsTrigger value="session" className="gap-1.5">
              <AudioLines size={13} />
              Session{turnCount > 0 && ` (${turnCount})`}
            </TabsTrigger>
            <TabsTrigger value="metrics" className="gap-1.5">
              <BarChart3 size={13} />
              Performance
            </TabsTrigger>
            <TabsTrigger value="config" className="gap-1.5">
              <Settings size={13} />
              Config
            </TabsTrigger>
          </TabsList>

          <TabsContent value="session" className="mt-4">
            <div className="rounded-lg border p-5">
              <SessionTimeline
                metrics={metrics}
                recordUrl={session.record_url}
                onTurnClick={setHighlightedTurn}
                sessionCreatedAt={session.created_at}
              />
              <Separator className="my-5" />
              <TurnTranscriptSection
                chatHistory={session.chat_history}
                metrics={metrics}
                highlightedTurn={highlightedTurn}
                embedded
              />
            </div>
          </TabsContent>

          <TabsContent value="metrics" className="mt-4 flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <LatencyPercentilesChart metrics={metrics} />
              <PipelineBreakdownChart metrics={metrics} />
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <LatencyOverTurnsChart metrics={metrics} />
              <TokenUsageSection metrics={metrics} />
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <TalkTimeChart metrics={metrics} />
              <LlmThroughputChart metrics={metrics} />
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <CacheEfficiencyChart metrics={metrics} />
            </div>
          </TabsContent>

          <TabsContent value="config" className="mt-4">
            <div className="rounded-lg border p-5">
              <div className="flex items-center gap-2 mb-4">
                <Settings size={15} className="text-muted-foreground" />
                <span className="text-s-400 font-medium">Session Data</span>
              </div>
              <pre className="text-xs font-mono bg-muted p-4 rounded-md overflow-auto max-h-[500px] leading-relaxed">
                {JSON.stringify(
                  {
                    session_id: session.session_id,
                    state: session.state,
                    started_at: session.started_at,
                    ended_at: session.ended_at,
                    duration_ms: session.duration_ms,
                    turn_count: session.turn_count,
                    has_stt: session.has_stt,
                    has_llm: session.has_llm,
                    has_tts: session.has_tts,
                    record_url: session.record_url,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </ScrollArea>
  )
}
