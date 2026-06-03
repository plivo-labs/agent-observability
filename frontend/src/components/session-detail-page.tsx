import { useState } from 'react'
import { Activity, AudioLines, BarChart3, ChevronRight, Settings2 } from 'lucide-react'
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
import { SessionEvaluationsDrawer } from '@/components/session-evaluations-drawer'

export const SessionDetailPage = ({ onBack }: { onBack?: () => void }) => {
  const { session, loading, error } = useSession()
  const [evaluationsOpen, setEvaluationsOpen] = useState(false)

  if (loading) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <div className="flex flex-col gap-3">
          <div className="ao-skeleton ao-skeleton--title" style={{ width: '30%' }} />
          <div className="ao-skeleton ao-skeleton--line" style={{ width: '55%' }} />
        </div>
        <div className="ao-stat-row">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="ao-stat">
              <div className="ao-skeleton" style={{ height: 12, width: '50%', marginBottom: 14 }} />
              <div className="ao-skeleton" style={{ height: 28, width: '65%' }} />
            </div>
          ))}
        </div>
        <div className="ao-panel">
          <div className="ao-panel-body flex flex-col gap-3">
            <div className="ao-skeleton ao-skeleton--title" />
            <div className="ao-skeleton ao-skeleton--line" />
            <div className="ao-skeleton ao-skeleton--line" style={{ width: '80%' }} />
          </div>
        </div>
      </div>
    )
  }

  if (error || !session) {
    return (
      <div className="ao-empty">
        <div className="ao-empty-icon">
          <AudioLines />
        </div>
        <div className="ao-empty-title">Session not found</div>
        <div className="ao-empty-text">{error ?? 'We couldn’t load this session.'}</div>
        {onBack && (
          <div className="ao-empty-actions">
            <button type="button" className="ao-btn ao-btn--outline" onClick={onBack}>
              Back to sessions
            </button>
          </div>
        )}
      </div>
    )
  }

  const metrics = session.session_metrics
  const turnCount = metrics?.turns?.length ?? session.turn_count ?? 0
  const eventCount = session.events?.length ?? 0
  const hasRecording = Boolean(session.record_url)

  return (
    <>
      {onBack && (
        <nav className="mb-4 flex items-center gap-1.5 font-mono text-[12px] text-[hsl(var(--tertiary))]">
          <button
            type="button"
            onClick={onBack}
            className="text-[hsl(var(--muted-foreground))] transition-colors hover:text-[hsl(var(--link))]"
          >
            Sessions
          </button>
          <ChevronRight size={13} className="opacity-60" />
          <span className="truncate text-foreground">{session.session_id}</span>
        </nav>
      )}

      <SessionHeader onEvaluationsClick={() => setEvaluationsOpen(true)} />

      <div className="ao-reveal ao-reveal-1 mt-6">
        <MetricSummaryCards />
      </div>

      <SessionEvaluationsDrawer
        open={evaluationsOpen}
        onOpenChange={setEvaluationsOpen}
      />

      <Tabs defaultValue="session" className="ao-reveal ao-reveal-2 mt-8 min-w-0">
        <TabsList className="ao-subtabs max-w-full overflow-x-auto">
          <TabsTrigger value="session">
            <AudioLines size={14} /> Session
            {turnCount > 0 && <span className="count">{turnCount}</span>}
          </TabsTrigger>
          <TabsTrigger value="metrics">
            <BarChart3 size={14} /> Performance
          </TabsTrigger>
          <TabsTrigger value="events">
            <Activity size={14} /> Events
            {eventCount > 0 && <span className="count">{eventCount}</span>}
          </TabsTrigger>
          <TabsTrigger value="config">
            <Settings2 size={14} /> Config
          </TabsTrigger>
        </TabsList>

        <TabsContent value="session" className="min-w-0">
          <div className="flex flex-col gap-4">
            {hasRecording && (
              <div className="ao-panel">
                <div className="ao-panel-body">
                  <SessionTimeline />
                </div>
              </div>
            )}
            <TurnTranscriptSection />
          </div>
        </TabsContent>

        <TabsContent value="metrics" className="min-w-0">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <LatencyPercentilesChart />
            <PipelineBreakdownChart />
            <LatencyOverTurnsChart />
            <TokenUsageSection />
          </div>
        </TabsContent>

        <TabsContent value="events" className="min-w-0">
          <SessionEvents />
        </TabsContent>

        <TabsContent value="config" className="min-w-0">
          <SessionConfig />
        </TabsContent>
      </Tabs>
    </>
  )
}
