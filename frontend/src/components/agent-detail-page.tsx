import { useMemo } from 'react'
import { parseAsStringEnum, useQueryState } from 'nuqs'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConversationEvalsTab } from '@/components/conversation-evals-tab'
import { SessionsPage } from '@/components/sessions-page'
import { AgentRunsPage } from '@/components/agent-runs-page'
import { AgentScopeHeader } from '@/components/agent-scope-header'
import type { AgentStatsRange } from '@/lib/observability-types'

interface AgentDetailPageProps {
  agentId: string
  onSessionClick?: (sessionId: string) => void
  onRunClick?: (runId: string) => void
  onCompare?: (runIdA: string, runIdB: string) => void
}

const TAB_VALUES = ['sessions', 'simulation-evals', 'conversation-evals'] as const
type TabValue = (typeof TAB_VALUES)[number]

const RANGE_VALUES = ['24h', '7d', '30d'] as const

export const AgentDetailPage = ({
  agentId,
  onSessionClick,
  onRunClick,
  onCompare,
}: AgentDetailPageProps) => {
  // URL-synced tab + range so links into the agent dashboard are deep-
  // linkable. parseAsStringEnum keeps the URL stable even if a stale
  // value lingers from an older deploy.
  const [tabRaw, setTab] = useQueryState(
    'tab',
    parseAsStringEnum([...TAB_VALUES]).withDefault('sessions'),
  )
  const [rangeRaw, setRange] = useQueryState(
    'range',
    // 7d is the sensible default — most agents have sparse activity at
    // any single 24h window, so opening the dashboard on 24h almost
    // always shows an empty list. Users can drill into 24h explicitly
    // when they care about the last day.
    parseAsStringEnum([...RANGE_VALUES]).withDefault('7d'),
  )
  const tab = useMemo<TabValue>(() => tabRaw as TabValue, [tabRaw])
  const range = useMemo<AgentStatsRange>(() => rangeRaw as AgentStatsRange, [rangeRaw])

  // Range picker only matters on the Sessions tab, but keep the slot
  // reserved so the header doesn't reflow as you switch.
  const rangePicker = tab === 'sessions' ? (
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
  ) : null

  return (
    <div className="w-full p-6 flex flex-col gap-4 min-w-0">
      <AgentScopeHeader agentId={agentId} rightSlot={rangePicker} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
        <TabsList>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="simulation-evals">Simulation Evals</TabsTrigger>
          <TabsTrigger value="conversation-evals">Conversation Evals</TabsTrigger>
        </TabsList>

        <TabsContent value="sessions" className="mt-4">
          {/* SessionsPage / EvalsPage carry their own padding when used
              standalone; embedded here we let the tab content's padding
              govern instead of nudging back with -mx-6 (which made these
              tabs render slightly wider than Conversation
              Evals — visible misalignment when switching tabs). */}
          <SessionsPage
            onSessionClick={onSessionClick}
            agentId={agentId}
            range={range}
          />
        </TabsContent>

        <TabsContent value="simulation-evals" className="mt-4">
          <AgentRunsPage
            agentId={agentId}
            embedded
            onRunClick={onRunClick}
            onCompare={onCompare}
          />
        </TabsContent>

        <TabsContent value="conversation-evals" className="mt-4">
          {/* No accountId passed — eval list spans all accounts for this id. */}
          <ConversationEvalsTab agentId={agentId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
