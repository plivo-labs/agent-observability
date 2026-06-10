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

// ── Fleet-wide stats ────────────────────────────────────────────────────────
//
// Same engine as getAgentStats (src/agents/db.ts) minus the agent_id
// predicate: every query starts from a `win` CTE of all sessions in the
// time window, optionally scoped to one account. The SQL fragments are
// shared via src/stats-sql.ts so the metric definitions can't drift
// between the per-agent and fleet views.

export interface FleetStatsBucket {
  bucket_start: string;
  session_count: number;
  avg_duration_ms: number | null;
  p95_user_perceived_ms: number | null;
  estimated_cost_usd: number | null;
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

// Interruption rate over chat_history: turn semantics match
// src/metrics.ts — one turn per assistant message; interrupted is the
// boolean barge-in flag on that item.
const INTERRUPTION_COUNTS = (winAlias: string) => `
  SELECT
    COUNT(*) FILTER (WHERE ${ASSISTANT_MSG_WHERE})::int AS assistant_turns,
    COUNT(*) FILTER (WHERE ${ASSISTANT_MSG_WHERE} AND ${INTERRUPTED_WHERE})::int AS interrupted_turns
  FROM ${winAlias}, ${CHAT_HISTORY_ELEMS(`${winAlias}.chat_history`)} AS item`;

function rate(interrupted: unknown, total: unknown): number | null {
  const t = Number(total);
  if (!Number.isFinite(t) || t <= 0) return null;
  return Number(interrupted) / t;
}

export async function getFleetStats(
  range = "7d",
  accountId: string | null = null,
): Promise<FleetStats> {
  const { interval, bucket } = RANGE_TO_INTERVAL[range] ?? RANGE_TO_INTERVAL["24h"];

  const [bucketRows, totalsRow, agentRows, accountRows] = await Promise.all([
    // 1. Per-bucket series: counts/durations/cost + p95 perceived +
    //    interruption rate. Same three-layer CTE shape as getAgentStats,
    //    plus interruption_buckets over chat_history.
    sql.unsafe(
      `WITH win AS (
         SELECT id, ended_at, duration_ms, session_metrics, chat_history, estimated_cost_usd
         FROM agent_transport_sessions
         WHERE ${WIN_WHERE}
       ),
       session_buckets AS (
         SELECT
           date_trunc($3, ended_at) AS bucket,
           COUNT(*)::int                  AS session_count,
           AVG(duration_ms)::int          AS avg_duration_ms,
           SUM(estimated_cost_usd)::float AS estimated_cost_usd
         FROM win
         GROUP BY date_trunc($3, ended_at)
       ),
       turns AS (
         SELECT
           date_trunc($3, win.ended_at) AS bucket,
           ${PERCEIVED_MS_SQL} AS perceived_ms
         FROM win, ${PER_TURN_ELEMS("win.session_metrics")} AS m
         WHERE ${PERCEIVED_MS_WHERE}
       ),
       turn_buckets AS (
         SELECT
           bucket,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY perceived_ms)::int
             AS p95_user_perceived_ms
         FROM turns
         GROUP BY bucket
       ),
       interruption_buckets AS (
         SELECT
           date_trunc($3, win.ended_at) AS bucket,
           COUNT(*) FILTER (WHERE ${ASSISTANT_MSG_WHERE})::int AS assistant_turns,
           COUNT(*) FILTER (WHERE ${ASSISTANT_MSG_WHERE} AND ${INTERRUPTED_WHERE})::int AS interrupted_turns
         FROM win, ${CHAT_HISTORY_ELEMS("win.chat_history")} AS item
         GROUP BY date_trunc($3, win.ended_at)
       )
       SELECT
         sb.bucket AS bucket_start,
         sb.session_count,
         sb.avg_duration_ms,
         sb.estimated_cost_usd,
         tb.p95_user_perceived_ms,
         ib.assistant_turns,
         ib.interrupted_turns
       FROM session_buckets sb
       LEFT JOIN turn_buckets tb USING (bucket)
       LEFT JOIN interruption_buckets ib USING (bucket)
       ORDER BY sb.bucket ASC`,
      [interval, accountId, bucket],
    ),
    // 2. Window totals.
    sql.unsafe(
      `WITH win AS (
         SELECT id, session_id, agent_id, session_metrics, chat_history,
                duration_ms, turn_count, estimated_cost_usd
         FROM agent_transport_sessions
         WHERE ${WIN_WHERE}
       ),
       turns AS (
         SELECT ${PERCEIVED_MS_SQL} AS perceived_ms
         FROM win, ${PER_TURN_ELEMS("win.session_metrics")} AS m
         WHERE ${PERCEIVED_MS_WHERE}
       ),
       interruptions AS (
         ${INTERRUPTION_COUNTS("win")}
       ),
       latest_outcomes AS (
         SELECT DISTINCT ON (session_id) session_id, outcome
         FROM session_outcomes
         WHERE session_id IN (SELECT session_id FROM win)
         ORDER BY session_id, COALESCE(observed_at, updated_at, created_at) DESC
       )
       SELECT
         (SELECT COUNT(*) FROM win)::int AS total_sessions,
         (SELECT COUNT(DISTINCT agent_id) FROM win WHERE agent_id IS NOT NULL)::int AS active_agents,
         (SELECT SUM(estimated_cost_usd) FROM win)::float AS total_estimated_cost_usd,
         (SELECT AVG(duration_ms) FROM win)::int AS avg_duration_ms,
         (SELECT AVG(turn_count) FROM win)::float AS avg_turn_count,
         (SELECT percentile_disc(0.50) WITHIN GROUP (ORDER BY perceived_ms) FROM turns)::int AS p50_user_perceived_ms,
         (SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY perceived_ms) FROM turns)::int AS p95_user_perceived_ms,
         (SELECT percentile_disc(0.99) WITHIN GROUP (ORDER BY perceived_ms) FROM turns)::int AS p99_user_perceived_ms,
         (SELECT assistant_turns FROM interruptions) AS assistant_turns,
         (SELECT interrupted_turns FROM interruptions) AS interrupted_turns,
         (
           SELECT CASE
             WHEN COUNT(*) = 0 THEN NULL
             ELSE SUM(CASE WHEN verdict = 'pass' THEN 1 ELSE 0 END)::float / COUNT(*)::float
           END
           FROM session_external_evals see
           WHERE see.session_id IN (SELECT session_id FROM win)
         ) AS llm_pass_rate,
         (
           SELECT CASE
             WHEN COUNT(*) = 0 THEN NULL
             ELSE SUM(CASE WHEN outcome IN ('success', 'lk.success') THEN 1 ELSE 0 END)::float / COUNT(*)::float
           END
           FROM latest_outcomes
         ) AS outcome_success_rate,
         (
           SELECT CASE
             WHEN SUM(total) = 0 OR SUM(total) IS NULL THEN NULL
             ELSE SUM(passed)::float / SUM(total)::float
           END
           FROM eval_runs
           WHERE started_at >= NOW() - $1::interval
             AND ($2::text IS NULL OR account_id = $2)
         ) AS ci_pass_rate`,
      [interval, accountId],
    ),
    // 3. Top agents by volume. agent_id can be NULL on legacy rows —
    //    grouped under a NULL bucket the UI labels "(unattributed)".
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
    // 4. Sessions by account.
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

  const totals = totalsRow[0] ?? {};

  return {
    range,
    account_id: accountId,
    total_sessions: totals.total_sessions ?? 0,
    active_agents: totals.active_agents ?? 0,
    total_estimated_cost_usd:
      totals.total_estimated_cost_usd != null ? Number(totals.total_estimated_cost_usd) : null,
    avg_duration_ms: totals.avg_duration_ms ?? null,
    avg_turn_count: totals.avg_turn_count != null ? Number(totals.avg_turn_count) : null,
    p50_user_perceived_ms: totals.p50_user_perceived_ms ?? null,
    p95_user_perceived_ms: totals.p95_user_perceived_ms ?? null,
    p99_user_perceived_ms: totals.p99_user_perceived_ms ?? null,
    interruption_rate: rate(totals.interrupted_turns, totals.assistant_turns),
    llm_pass_rate: totals.llm_pass_rate != null ? Number(totals.llm_pass_rate) : null,
    outcome_success_rate:
      totals.outcome_success_rate != null ? Number(totals.outcome_success_rate) : null,
    ci_pass_rate: totals.ci_pass_rate != null ? Number(totals.ci_pass_rate) : null,
    buckets: bucketRows.map((r: any) => ({
      bucket_start: r.bucket_start,
      session_count: r.session_count,
      avg_duration_ms: r.avg_duration_ms,
      p95_user_perceived_ms: r.p95_user_perceived_ms,
      estimated_cost_usd: r.estimated_cost_usd != null ? Number(r.estimated_cost_usd) : null,
      interruption_rate: rate(r.interrupted_turns, r.assistant_turns),
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
