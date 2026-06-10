import { sql } from "../db.js";
import {
  ASSISTANT_MSG_WHERE,
  CHAT_HISTORY_ELEMS,
  INTERRUPTED_WHERE,
  PER_TURN_ELEMS,
  PERCEIVED_MS_SQL,
  PERCEIVED_MS_WHERE,
  RANGE_TO_INTERVAL,
} from "../stats-sql.js";
import { getStatsCore, type CoreStatsBucket } from "../stats-core.js";

// ── Fleet-wide stats ────────────────────────────────────────────────────────
//
// The bucket/totals engine is src/stats-core.ts (shared with the per-agent
// Overview tab — agentId=null widens it to the whole fleet). This module
// adds the fleet-only extras: interruption rates, latest-outcome success,
// active-agent count, and the agent/account breakdown tables.

export interface FleetStatsBucket extends CoreStatsBucket {
  /** interrupted assistant turns / assistant turns in bucket, 0..1 */
  interruption_rate: number | null;
}

export interface FleetAgentBreakdownRow {
  agent_id: string | null;
  agent_name: string | null;
  session_count: number;
  avg_duration_ms: number | null;
  p95_user_perceived_ms: number | null;
  estimated_cost_usd: number | null;
  interruption_rate: number | null;
  outcome_success_rate: number | null;
}

export interface FleetAccountBreakdownRow {
  account_id: string | null;
  session_count: number;
  estimated_cost_usd: number | null;
}

export interface FleetStats {
  range: string;
  account_id: string | null;
  total_sessions: number;
  active_agents: number;
  total_estimated_cost_usd: number | null;
  avg_duration_ms: number | null;
  avg_turn_count: number | null;
  p50_user_perceived_ms: number | null;
  p95_user_perceived_ms: number | null;
  p99_user_perceived_ms: number | null;
  interruption_rate: number | null;
  llm_pass_rate: number | null;
  outcome_success_rate: number | null;
  ci_pass_rate: number | null;
  buckets: FleetStatsBucket[];
  agent_breakdown: FleetAgentBreakdownRow[];
  account_breakdown: FleetAccountBreakdownRow[];
}

const WIN_WHERE = `
  ended_at >= NOW() - $1::interval
  AND ($2::text IS NULL OR account_id = $2)`;

function rate(part: unknown, total: unknown): number | null {
  const t = Number(total);
  if (!Number.isFinite(t) || t <= 0) return null;
  return Number(part) / t;
}

export async function getFleetStats(
  range = "7d",
  accountId: string | null = null,
): Promise<FleetStats> {
  const { interval, bucket } = RANGE_TO_INTERVAL[range] ?? RANGE_TO_INTERVAL["24h"];

  const [core, extrasRow, interruptionBucketRows, agentRows, accountRows] = await Promise.all([
    // Shared engine: volume/duration/cost/p95 buckets + window totals +
    // pass rates, fleet-wide via agentId=null.
    getStatsCore(null, range, accountId),
    // Fleet-only window totals.
    sql.unsafe(
      `WITH win AS (
         SELECT id, session_id, agent_id, chat_history
         FROM agent_transport_sessions
         WHERE ${WIN_WHERE}
       ),
       latest_outcomes AS (
         SELECT DISTINCT ON (session_id) session_id, outcome
         FROM session_outcomes
         WHERE session_id IN (SELECT session_id FROM win)
         ORDER BY session_id, COALESCE(observed_at, updated_at, created_at) DESC
       )
       SELECT
         (SELECT COUNT(DISTINCT agent_id) FROM win WHERE agent_id IS NOT NULL)::int AS active_agents,
         (
           SELECT COUNT(*) FILTER (WHERE ${ASSISTANT_MSG_WHERE})::int
           FROM win, ${CHAT_HISTORY_ELEMS("win.chat_history")} AS item
         ) AS assistant_turns,
         (
           SELECT COUNT(*) FILTER (WHERE ${ASSISTANT_MSG_WHERE} AND ${INTERRUPTED_WHERE})::int
           FROM win, ${CHAT_HISTORY_ELEMS("win.chat_history")} AS item
         ) AS interrupted_turns,
         (
           SELECT CASE
             WHEN COUNT(*) = 0 THEN NULL
             ELSE SUM(CASE WHEN outcome IN ('success', 'lk.success') THEN 1 ELSE 0 END)::float / COUNT(*)::float
           END
           FROM latest_outcomes
         ) AS outcome_success_rate`,
      [interval, accountId],
    ),
    // Per-bucket interruption rates — merged into the core buckets in JS.
    sql.unsafe(
      `WITH win AS (
         SELECT ended_at, chat_history
         FROM agent_transport_sessions
         WHERE ${WIN_WHERE}
       )
       SELECT
         date_trunc($3, win.ended_at) AS bucket_start,
         COUNT(*) FILTER (WHERE ${ASSISTANT_MSG_WHERE})::int AS assistant_turns,
         COUNT(*) FILTER (WHERE ${ASSISTANT_MSG_WHERE} AND ${INTERRUPTED_WHERE})::int AS interrupted_turns
       FROM win, ${CHAT_HISTORY_ELEMS("win.chat_history")} AS item
       GROUP BY date_trunc($3, win.ended_at)`,
      [interval, accountId, bucket],
    ),
    // Top agents by volume. agent_id can be NULL on legacy rows —
    // grouped under a NULL bucket the UI labels "(unattributed)".
    sql.unsafe(
      `WITH win AS (
         SELECT id, session_id, agent_id, agent_name, ended_at, duration_ms,
                session_metrics, chat_history, estimated_cost_usd
         FROM agent_transport_sessions
         WHERE ${WIN_WHERE}
       ),
       per_agent AS (
         SELECT
           agent_id,
           MAX(agent_name) AS agent_name,
           COUNT(*)::int AS session_count,
           AVG(duration_ms)::int AS avg_duration_ms,
           SUM(estimated_cost_usd)::float AS estimated_cost_usd
         FROM win
         GROUP BY agent_id
       ),
       agent_turns AS (
         SELECT win.agent_id, ${PERCEIVED_MS_SQL} AS perceived_ms
         FROM win, ${PER_TURN_ELEMS("win.session_metrics")} AS m
         WHERE ${PERCEIVED_MS_WHERE}
       ),
       agent_p95 AS (
         SELECT agent_id,
                percentile_disc(0.95) WITHIN GROUP (ORDER BY perceived_ms)::int AS p95_user_perceived_ms
         FROM agent_turns
         GROUP BY agent_id
       ),
       agent_interruptions AS (
         SELECT win.agent_id,
                COUNT(*) FILTER (WHERE ${ASSISTANT_MSG_WHERE})::int AS assistant_turns,
                COUNT(*) FILTER (WHERE ${ASSISTANT_MSG_WHERE} AND ${INTERRUPTED_WHERE})::int AS interrupted_turns
         FROM win, ${CHAT_HISTORY_ELEMS("win.chat_history")} AS item
         GROUP BY win.agent_id
       ),
       agent_outcomes AS (
         SELECT w.agent_id,
                COUNT(*)::int AS outcome_total,
                COUNT(*) FILTER (WHERE lo.outcome IN ('success', 'lk.success'))::int AS outcome_success
         FROM (
           SELECT DISTINCT ON (session_id) session_id, outcome
           FROM session_outcomes
           WHERE session_id IN (SELECT session_id FROM win)
           ORDER BY session_id, COALESCE(observed_at, updated_at, created_at) DESC
         ) lo
         JOIN win w ON w.session_id = lo.session_id
         GROUP BY w.agent_id
       )
       SELECT
         pa.agent_id,
         pa.agent_name,
         pa.session_count,
         pa.avg_duration_ms,
         pa.estimated_cost_usd,
         ap.p95_user_perceived_ms,
         ai.assistant_turns,
         ai.interrupted_turns,
         ao.outcome_total,
         ao.outcome_success
       FROM per_agent pa
       LEFT JOIN agent_p95 ap ON ap.agent_id IS NOT DISTINCT FROM pa.agent_id
       LEFT JOIN agent_interruptions ai ON ai.agent_id IS NOT DISTINCT FROM pa.agent_id
       LEFT JOIN agent_outcomes ao ON ao.agent_id IS NOT DISTINCT FROM pa.agent_id
       ORDER BY pa.session_count DESC
       LIMIT 10`,
      [interval, accountId],
    ),
    // Sessions by account.
    sql.unsafe(
      `SELECT account_id,
              COUNT(*)::int AS session_count,
              SUM(estimated_cost_usd)::float AS estimated_cost_usd
       FROM agent_transport_sessions
       WHERE ${WIN_WHERE}
       GROUP BY account_id
       ORDER BY session_count DESC
       LIMIT 10`,
      [interval, accountId],
    ),
  ]);

  const extras = extrasRow[0] ?? {};

  // Fold per-bucket interruption rates into the shared buckets.
  const interruptionByBucket = new Map<string, number | null>(
    interruptionBucketRows.map((r: any) => [
      new Date(r.bucket_start).toISOString(),
      rate(r.interrupted_turns, r.assistant_turns),
    ]),
  );

  return {
    range,
    account_id: accountId,
    ...core.totals,
    active_agents: extras.active_agents ?? 0,
    interruption_rate: rate(extras.interrupted_turns, extras.assistant_turns),
    outcome_success_rate:
      extras.outcome_success_rate != null ? Number(extras.outcome_success_rate) : null,
    buckets: core.buckets.map((b) => ({
      ...b,
      interruption_rate:
        interruptionByBucket.get(new Date(b.bucket_start).toISOString()) ?? null,
    })),
    agent_breakdown: agentRows.map((r: any) => ({
      agent_id: r.agent_id,
      agent_name: r.agent_name,
      session_count: r.session_count,
      avg_duration_ms: r.avg_duration_ms,
      p95_user_perceived_ms: r.p95_user_perceived_ms,
      estimated_cost_usd: r.estimated_cost_usd != null ? Number(r.estimated_cost_usd) : null,
      interruption_rate: rate(r.interrupted_turns, r.assistant_turns),
      outcome_success_rate: rate(r.outcome_success, r.outcome_total),
    })),
    account_breakdown: accountRows.map((r: any) => ({
      account_id: r.account_id,
      session_count: r.session_count,
      estimated_cost_usd: r.estimated_cost_usd != null ? Number(r.estimated_cost_usd) : null,
    })),
  };
}
