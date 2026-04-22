import { Activity, AudioLines, BarChart3, Settings2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useSession } from '@/lib/observability-hooks'
import { MetricSummaryCards } from '@/components/metric-summary-cards'
import { LatencyPercentilesChart } from '@/components/latency-percentiles-chart'
import { PipelineBreakdownChart } from '@/components/pipeline-breakdown-chart'
import { LatencyOverTurnsChart } from '@/components/latency-over-turns-chart'
import { TokenUsageSection } from '@/components/token-usage-section'
import { TurnTranscriptSection } from '@/components/turn-transcript'
import { SessionHeader } from '@/components/session-header'
import { SessionTimeline } from '@/components/session-timeline/session-timeline'
import { SessionConfig } from '@/components/session-config'
import { SessionEvents } from '@/components/session-events'

export const SessionDetailPage = ({ onBack }: { onBack?: () => void }) => {
  const { session, loading, error } = useSession()

  if (loading) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: 'hsl(var(--tertiary))' }}>
        Loading session details…
      </div>
    )
  }

  if (error || !session) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: 'hsl(var(--destructive))' }}>
        <p>{error ?? 'Session not found'}</p>
      </div>
    )
  }

  const metrics = session.session_metrics
  const turnCount = metrics?.turns?.length ?? session.turn_count ?? 0
  const eventCount = session.events?.length ?? 0

  return (
    <>
      {onBack && (
        <div className="obs-crumbs">
          <button
            type="button"
            onClick={onBack}
            style={{ all: 'unset', cursor: 'pointer', color: 'hsl(var(--secondary))' }}
          >
            Sessions
          </button>
          <span className="sep">/</span>
          <span className="cur">{session.session_id}</span>
        </div>
      )}

      <SessionHeader />
      <MetricSummaryCards />

      <Tabs defaultValue="session">
        <TabsList>
          <TabsTrigger value="session">
            <AudioLines size={14} /> Session
            {turnCount > 0 && <span style={{ marginLeft: 4, color: 'hsl(var(--tertiary))', font: 'var(--text-xxs-600)' }}>({turnCount})</span>}
          </TabsTrigger>
          <TabsTrigger value="metrics">
            <BarChart3 size={14} /> Performance
          </TabsTrigger>
          <TabsTrigger value="events">
            <Activity size={14} /> Events
            {eventCount > 0 && <span style={{ marginLeft: 4, color: 'hsl(var(--tertiary))', font: 'var(--text-xxs-600)' }}>({eventCount})</span>}
          </TabsTrigger>
          <TabsTrigger value="config">
            <Settings2 size={14} /> Config
          </TabsTrigger>
        </TabsList>

        <TabsContent value="session" style={{ marginTop: 4 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <SessionTimeline />
            <TurnTranscriptSection embedded />
          </div>
        </TabsContent>

        <TabsContent value="metrics" style={{ marginTop: 4 }}>
          <div className="perf-grid">
            <LatencyPercentilesChart />
            <PipelineBreakdownChart />
            <LatencyOverTurnsChart />
            <TokenUsageSection />
          </div>
        </TabsContent>

        <TabsContent value="events" style={{ marginTop: 4 }}>
          <SessionEvents />
        </TabsContent>

        <TabsContent value="config" style={{ marginTop: 4 }}>
          <SessionConfig />
        </TabsContent>
      </Tabs>
    </>
  )
}
