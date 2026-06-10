import { useState } from 'react'
import { Activity, AudioLines, BarChart3, Settings2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { useSession } from '@/lib/observability-hooks'
import { AgentScopeHeader } from '@/components/agent-scope-header'
import { MetricSummaryCards } from '@/components/metric-summary-cards'
import { LatencyPercentilesChart } from '@/components/latency-percentiles-chart'
import { PipelineBreakdownChart } from '@/components/pipeline-breakdown-chart'
import { LatencyOverTurnsChart } from '@/components/latency-over-turns-chart'
import { TokenUsageSection } from '@/components/token-usage-section'
import { ConversationDynamics } from '@/components/conversation-dynamics'
import { TurnTranscriptSection } from '@/components/turn-transcript'
import { SessionHeader } from '@/components/session-header'
import { SessionTimeline } from '@/components/session-timeline/session-timeline'
import { SessionConfig } from '@/components/session-config'
import { SessionEvents } from '@/components/session-events'
import { SessionEvaluationsDrawer } from '@/components/session-evaluations-drawer'

export const SessionDetailPage = () => {
  const { session, loading, error } = useSession()
  const [evaluationsOpen, setEvaluationsOpen] = useState(false)

  if (loading) {
    return (
      <div className="p-6 flex flex-col gap-4 relative" aria-busy="true">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-[120px] w-full rounded-none" />
        <div className="obs-metrics">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[76px] rounded-none" />
          ))}
        </div>
        <Skeleton className="h-9 w-80" />
        <Skeleton className="h-[320px] w-full rounded-none" />
      </div>
    )
  }

  if (error || !session) {
    return (
      <div className="p-6 text-center text-destructive">
        <p>{error ?? 'Session not found'}</p>
      </div>
    )
  }

  const metrics = session.session_metrics
  const turnCount = metrics?.turns?.length ?? session.turn_count ?? 0
  const eventCount = session.events?.length ?? 0
  const hasRecording = Boolean(session.record_url)

  return (
    <div className="p-6 flex flex-col gap-4 relative">
      {session.agent_id && (
        <AgentScopeHeader
          agentId={session.agent_id}
          trail={[
            {
              label: 'Sessions',
              to: `/agents/${encodeURIComponent(session.agent_id)}?tab=sessions`,
            },
            { label: session.session_id, mono: true },
          ]}
        />
      )}

      <SessionHeader onEvaluationsClick={() => setEvaluationsOpen(true)} />
      <MetricSummaryCards />
      <SessionEvaluationsDrawer
        open={evaluationsOpen}
        onOpenChange={setEvaluationsOpen}
      />

      <Tabs defaultValue="session" className="min-w-0">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="session">
            <AudioLines size={14} /> Session
            {turnCount > 0 && <span style={{ marginLeft: 4, color: 'var(--tertiary)', font: 'var(--text-xxs-600)' }}>({turnCount})</span>}
          </TabsTrigger>
          <TabsTrigger value="metrics">
            <BarChart3 size={14} /> Performance
          </TabsTrigger>
          <TabsTrigger value="events">
            <Activity size={14} /> Events
            {eventCount > 0 && <span style={{ marginLeft: 4, color: 'var(--tertiary)', font: 'var(--text-xxs-600)' }}>({eventCount})</span>}
          </TabsTrigger>
          <TabsTrigger value="config">
            <Settings2 size={14} /> Config
          </TabsTrigger>
        </TabsList>

        <TabsContent value="session" className="min-w-0 mt-1">
          <div className="flex flex-col gap-4">
            {hasRecording && (
              <div className="rounded-lg border bg-card p-5">
                <SessionTimeline />
              </div>
            )}
            <TurnTranscriptSection />
          </div>
        </TabsContent>

        <TabsContent value="metrics" className="min-w-0 mt-1">
          <div className="perf-grid">
            <ConversationDynamics />
            <LatencyPercentilesChart />
            <PipelineBreakdownChart />
            <LatencyOverTurnsChart />
            <TokenUsageSection />
          </div>
        </TabsContent>

        <TabsContent value="events" className="min-w-0 mt-1">
          <SessionEvents />
        </TabsContent>

        <TabsContent value="config" className="min-w-0 mt-1">
          <SessionConfig />
        </TabsContent>
      </Tabs>
    </div>
  )
}
