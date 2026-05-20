import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Bot } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { ModalityChip, TransportBadge } from '@/components/obs-cells'
import { useAgent } from '@/lib/observability-hooks'

export interface AgentScopeHeaderTrailSegment {
  label: string
  /** When set, renders as a link. The current page is the last segment
   *  with no `to`. */
  to?: string
  /** Force monospace rendering — typical for opaque ids. */
  mono?: boolean
}

interface AgentScopeHeaderProps {
  /** Stable agent identifier. Read off `useParams` by the route, then
   *  passed in so this stays a pure presentational component. */
  agentId: string
  /** Breadcrumb segments to append after the agent name. Empty means
   *  the agent is the current page (e.g. /agents/:agentId). */
  trail?: AgentScopeHeaderTrailSegment[]
  /** Optional content rendered on the right side of the identity row.
   *  Used by the agent landing page for its 24h/7d/30d range picker. */
  rightSlot?: ReactNode
}

/**
 * Persistent header for all agent-scoped detail screens.
 *
 * Renders two parts: a breadcrumb (`Agents / <agent_name> / …trail`)
 * and an identity card (Bot icon, agent_name, modality chip, transport
 * badges, meta line). The same component appears at the top of the
 * agent landing, session detail, eval run detail, and eval case detail
 * pages so the "which agent am I looking at" context never disappears.
 *
 * Drives its own data via `useAgent` so callers only need to pass
 * `agentId` (typically from `useParams`).
 */
export const AgentScopeHeader = ({
  agentId,
  trail = [],
  rightSlot,
}: AgentScopeHeaderProps) => {
  const { agent, loading } = useAgent(agentId)
  const accountId = agent?.account_id ?? null
  const isLeaf = trail.length === 0
  const agentLabel = agent?.agent_name || agentId

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className="eval-breadcrumbs">
        <Link to="/">Agents</Link>
        <span className="eval-breadcrumbs__sep">/</span>
        {isLeaf ? (
          <span className="eval-breadcrumbs__current">{agentLabel}</span>
        ) : (
          <Link to={`/agents/${encodeURIComponent(agentId)}`}>{agentLabel}</Link>
        )}
        {trail.map((seg, i) => {
          const isLast = i === trail.length - 1
          return (
            <span key={`${seg.label}-${i}`} className="contents">
              <span className="eval-breadcrumbs__sep">/</span>
              {isLast || !seg.to ? (
                <span
                  className={
                    'eval-breadcrumbs__current' +
                    (seg.mono ? ' font-mono' : '')
                  }
                >
                  {seg.label}
                </span>
              ) : (
                <Link
                  to={seg.to}
                  className={seg.mono ? 'font-mono' : undefined}
                >
                  {seg.label}
                </Link>
              )}
            </span>
          )
        })}
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xl font-semibold">
            <Bot size={20} className="text-muted-foreground" />
            <span className="truncate">{agentLabel}</span>
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
        {rightSlot}
      </div>
    </div>
  )
}
