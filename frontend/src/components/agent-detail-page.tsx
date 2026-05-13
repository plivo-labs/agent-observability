import { useMemo } from 'react'
import { parseAsStringEnum, useQueryState } from 'nuqs'
import { ArrowLeft, Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { AgentOverviewTab } from '@/components/agent-overview-tab'
import { ConversationEvalsTab } from '@/components/conversation-evals-tab'
import { SessionsPage } from '@/components/sessions-page'
import { EvalsPage } from '@/components/evals-page'
import { ModalityChip, TransportBadge } from '@/components/obs-cells'
import { useAgent } from '@/lib/observability-hooks'
import type { AgentStatsRange } from '@/lib/observability-types'

interface AgentDetailPageProps {
  agentId: string
  onBack?: () => void
  onSessionClick?: (sessionId: string) => void
  onRunClick?: (runId: string) => void
}

const TAB_VALUES = ['overview', 'sessions', 'simulation-evals', 'conversation-evals'] as const
type TabValue = (typeof TAB_VALUES)[number]

const RANGE_VALUES = ['24h', '7d', '30d'] as const

export const AgentDetailPage = ({
  agentId,
  onBack,
  onSessionClick,
  onRunClick,
}: AgentDetailPageProps) => {
  const { agent, loading } = useAgent(agentId)
  // account isn't in the URL anymore — read it off the loaded agent
  // row so the header still shows context, but no longer use it to
  // narrow further server queries (stats/conversation-evals span all
  // accounts for this agent_id, which is what we want once agent_ids
  // are UUIDs).
  const accountId = agent?.account_id ?? null

  // URL-synced tab + range so links into the agent dashboard are deep-
  // linkable. parseAsStringEnum keeps the URL stable even if a stale
  // value lingers from an older deploy.
  const [tabRaw, setTab] = useQueryState(
    'tab',
    parseAsStringEnum([...TAB_VALUES]).withDefault('overview'),
  )
  const [rangeRaw, setRange] = useQueryState(
    'range',
    parseAsStringEnum([...RANGE_VALUES]).withDefault('24h'),
  )
  const tab = useMemo<TabValue>(() => tabRaw as TabValue, [tabRaw])
  const range = useMemo<AgentStatsRange>(() => rangeRaw as AgentStatsRange, [rangeRaw])

  return (
    <div className="w-full p-6 flex flex-col gap-4 min-w-0">
      <div className="flex items-center gap-3">
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
            <ArrowLeft size={16} className="mr-1" /> All agents
          </Button>
        )}
      </div>

      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xl font-semibold">
            <Bot size={20} className="text-muted-foreground" />
            {/* Show the human-readable name when present, fall back to
                the opaque agent_id. The id stays visible in the meta
                line below so the deep-link target is still discoverable. */}
            <span>{agent?.agent_name || agentId}</span>
            {agent?.modality && <ModalityChip value={agent.modality} size="md" />}
            {agent?.transports && agent.transports.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                {agent.transports.map((t) => (
                  <TransportBadge key={t} value={t} size="md" />
                ))}
              </div>
            )}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {agent?.agent_name && (
              <span className="text-xs">
                id: <span className="text-foreground">{agentId}</span>
              </span>
            )}
            {accountId && (
              <span className="text-xs">
                account: <span className="text-foreground">{accountId}</span>
              </span>
            )}
            {loading ? (
              <Skeleton className="h-4 w-48" />
            ) : agent ? (
              <span>
                {accountId ? '· ' : ''}
                {agent.session_count.toLocaleString()} sessions ·{' '}
                {agent.eval_run_count.toLocaleString()} simulation runs
              </span>
            ) : (
              <span>No telemetry yet for this agent.</span>
            )}
          </div>
        </div>

        {/* Range picker only matters on the Overview tab, but keep it
            visible to telegraph that the dashboard is windowed. */}
        {tab === 'overview' && (
          <div className="flex items-center gap-1 rounded-lg border bg-card p-1 text-xs">
            {RANGE_VALUES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={
                  'rounded px-2 py-1 ' +
                  (range === r
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground')
                }
              >
                {r}
              </button>
            ))}
          </div>
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="simulation-evals">Simulation Evals</TabsTrigger>
          <TabsTrigger value="conversation-evals">Conversation Evals</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          {/* No accountId passed — stats span all accounts for this id. */}
          <AgentOverviewTab agentId={agentId} range={range} />
        </TabsContent>

        <TabsContent value="sessions" className="mt-4">
          {/* SessionsPage / EvalsPage carry their own padding when used
              standalone; embedded here we let the tab content's padding
              govern instead of nudging back with -mx-6 (which made these
              tabs render slightly wider than Overview / Conversation
              Evals — visible misalignment when switching tabs). */}
          <SessionsPage onSessionClick={onSessionClick} agentId={agentId} />
        </TabsContent>

        <TabsContent value="simulation-evals" className="mt-4">
          <EvalsPage onRunClick={onRunClick} agentId={agentId} />
        </TabsContent>

        <TabsContent value="conversation-evals" className="mt-4">
          {/* No accountId passed — eval list spans all accounts for this id. */}
          <ConversationEvalsTab agentId={agentId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
