import { Activity, AudioLines, BarChart3, ChevronRight, Settings2 } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
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
      <ScrollArea className="h-[calc(100vh-53px)]">
        <div className="flex flex-col gap-5 p-6" aria-busy="true">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-[120px] w-full rounded-xl" />
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[76px] rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-9 w-80" />
          <Skeleton className="h-[320px] w-full rounded-xl" />
        </div>
      </ScrollArea>
    )
  }

  if (error || !session) {
    return (
      <div className="p-12 text-center text-destructive">
        <p>{error ?? 'Session not found'}</p>
      </div>
    )
  }

  const metrics = session.session_metrics
  const turnCount = metrics?.turns?.length ?? session.turn_count ?? 0
  const eventCount = session.events?.length ?? 0

  return (
    <ScrollArea className="h-[calc(100vh-53px)]">
      <div className="flex flex-col gap-5 p-6">
        {onBack && (
          <nav className="flex items-center gap-1.5 text-s-400">
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors bg-transparent border-none p-0 text-s-400"
              onClick={onBack}
            >
              Sessions
            </button>
            <ChevronRight size={14} className="text-muted-foreground/60" />
            <span className="font-mono truncate max-w-[300px]">{session.session_id}</span>
          </nav>
        )}

        {/* Auto-connected — these components use hooks internally */}
        <SessionHeader />
        <MetricSummaryCards />

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
            <TabsTrigger value="events" className="gap-1.5">
              <Activity size={13} />
              Events{eventCount > 0 && ` (${eventCount})`}
            </TabsTrigger>
            <TabsTrigger value="config" className="gap-1.5">
              <Settings2 size={13} />
              Config
            </TabsTrigger>
          </TabsList>

          <TabsContent value="session" className="mt-4">
            <div className="rounded-lg border p-5">
              <SessionTimeline />
              <Separator className="my-5" />
              <TurnTranscriptSection embedded />
            </div>
          </TabsContent>

          <TabsContent value="metrics" className="mt-4 flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <LatencyPercentilesChart />
              <PipelineBreakdownChart />
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <LatencyOverTurnsChart />
              <TokenUsageSection />
            </div>
          </TabsContent>

          <TabsContent value="events" className="mt-4">
            <SessionEvents />
          </TabsContent>

          <TabsContent value="config" className="mt-4">
            <SessionConfig />
          </TabsContent>

        </Tabs>
      </div>
    </ScrollArea>
  )
}
