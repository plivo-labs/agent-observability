import { sql } from "./db.js";
import {
  PER_TURN_ELEMS,
  PERCEIVED_MS_SQL,
  PERCEIVED_MS_WHERE,
  RANGE_TO_INTERVAL,
} from "./stats-sql.js";

// ── Shared stats engine ─────────────────────────────────────────────────────
//
// One query path for the session metrics that must agree between the
// per-agent Overview tab and the fleet-wide /analytics page: time-bucketed
// volume/duration/cost/p95 plus window totals and pass rates. `agentId`
// is nullable — null widens the window to every agent, which is the only
// difference between the two views. Callers add their view-specific
// extras (provider/transport breakdowns for agents; interruption/outcome/
// agent/account rollups for the fleet) on top.

export interface CoreStatsBucket {
  bucket_start: string;
  session_count: number;
  avg_duration_ms: number | null;
  p95_user_perceived_ms: number | null;
  estimated_cost_usd: number | null;
}

export interface CoreStatsTotals {
  total_sessions: number;
  total_estimated_cost_usd: number | null;
  avg_duration_ms: number | null;
  avg_turn_count: number | null;
  p50_user_perceived_ms: number | null;
  p95_user_perceived_ms: number | null;
  p99_user_perceived_ms: number | null;
  /** verdict='pass' share over session_external_evals in window, 0..1 */
  llm_pass_rate: number | null;
  /** passed/total over eval_runs in window, 0..1 */
  ci_pass_rate: number | null;
}

export interface CoreStats {
  buckets: CoreStatsBucket[];
  totals: CoreStatsTotals;
  interval: string;
  bucket: string;
}

export async function getStatsCore(
  agentId: string | null,
  range: string,
  accountId: string | null,
): Promise<CoreStats> {
  const { interval, bucket } = RANGE_TO_INTERVAL[range] ?? RANGE_TO_INTERVAL["24h"];

  const [bucketRows, totalsRow] = await Promise.all([
    // Per-bucket aggregates. Three CTE layers so we don't have to push a
    // correlated subquery through a GROUP BY:
    //   1. `win`            — raw sessions in the window
    //   2. `session_buckets`— per-bucket session counts + durations
    //   3. `turn_buckets`   — per-bucket p95 perceived latency from per_turn[]
    // LEFT JOIN so a bucket with sessions but no numeric per-turn metrics
    // still appears (p95 = NULL).
    sql.unsafe(
      `WITH win AS (
         SELECT id, ended_at, duration_ms, session_metrics, estimated_cost_usd
         FROM agent_transport_sessions
         WHERE ($1::text IS NULL OR agent_id = $1)
           AND ended_at >= NOW() - $2::interval
           AND ($4::text IS NULL OR account_id = $4)
       ),
       session_buckets AS (
         SELECT
           date_trunc($3, ended_at) AS bucket,
           COUNT(*)::int                    AS session_count,
           AVG(duration_ms)::int            AS avg_duration_ms,
           SUM(estimated_cost_usd)::float   AS estimated_cost_usd
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
       )
       SELECT
         sb.bucket           AS bucket_start,
         sb.session_count,
         sb.avg_duration_ms,
         sb.estimated_cost_usd,
         tb.p95_user_perceived_ms
       FROM session_buckets sb
       LEFT JOIN turn_buckets tb USING (bucket)
       ORDER BY sb.bucket ASC`,
      [agentId, interval, bucket, accountId],
    ),
    // Window totals — scalar subqueries over the same window.
    sql.unsafe(
      `WITH win AS (
         SELECT id, session_id, session_metrics, duration_ms, turn_count, estimated_cost_usd
         FROM agent_transport_sessions
         WHERE ($1::text IS NULL OR agent_id = $1)
           AND ended_at >= NOW() - $2::interval
           AND ($3::text IS NULL OR account_id = $3)
       ),
       turns AS (
         SELECT ${PERCEIVED_MS_SQL} AS perceived_ms
         FROM win, ${PER_TURN_ELEMS("win.session_metrics")} AS m
         WHERE ${PERCEIVED_MS_WHERE}
       )
       SELECT
         (SELECT COUNT(*) FROM win)::int AS total_sessions,
         (SELECT SUM(estimated_cost_usd) FROM win)::float AS total_estimated_cost_usd,
         (SELECT AVG(duration_ms) FROM win)::int AS avg_duration_ms,
         (SELECT AVG(turn_count) FROM win)::float AS avg_turn_count,
         (SELECT percentile_disc(0.50) WITHIN GROUP (ORDER BY perceived_ms) FROM turns)::int AS p50_user_perceived_ms,
         (SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY perceived_ms) FROM turns)::int AS p95_user_perceived_ms,
         (SELECT percentile_disc(0.99) WITHIN GROUP (ORDER BY perceived_ms) FROM turns)::int AS p99_user_perceived_ms,
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
             WHEN SUM(total) = 0 OR SUM(total) IS NULL THEN NULL
             ELSE SUM(passed)::float / SUM(total)::float
           END
           FROM eval_runs
           WHERE ($1::text IS NULL OR agent_id = $1)
             AND started_at >= NOW() - $2::interval
             AND ($3::text IS NULL OR account_id = $3)
         ) AS ci_pass_rate`,
      [agentId, interval, accountId],
    ),
  ]);

  const t = totalsRow[0] ?? {};
  return {
    interval,
    bucket,
    buckets: bucketRows.map((r: any) => ({
      bucket_start: r.bucket_start,
      session_count: r.session_count,
      avg_duration_ms: r.avg_duration_ms,
      p95_user_perceived_ms: r.p95_user_perceived_ms,
      estimated_cost_usd: r.estimated_cost_usd != null ? Number(r.estimated_cost_usd) : null,
    })),
    totals: {
      total_sessions: t.total_sessions ?? 0,
      total_estimated_cost_usd:
        t.total_estimated_cost_usd != null ? Number(t.total_estimated_cost_usd) : null,
      avg_duration_ms: t.avg_duration_ms ?? null,
      avg_turn_count: t.avg_turn_count != null ? Number(t.avg_turn_count) : null,
      p50_user_perceived_ms: t.p50_user_perceived_ms ?? null,
      p95_user_perceived_ms: t.p95_user_perceived_ms ?? null,
      p99_user_perceived_ms: t.p99_user_perceived_ms ?? null,
      llm_pass_rate: t.llm_pass_rate != null ? Number(t.llm_pass_rate) : null,
      ci_pass_rate: t.ci_pass_rate != null ? Number(t.ci_pass_rate) : null,
    },
  };
}
