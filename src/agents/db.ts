import { sql } from "../db.js";

// ── List ────────────────────────────────────────────────────────────────────
//
// Agents are a first-class entity (table: `agents`). agent_id ALONE is
// the natural key — same id observed across different accounts merges
// into one row (last-writer-wins on account_id and agent_name via
// upsertAgent's COALESCE-merge). Every ingest path upserts the agent
// row before inserting its session/eval row; FK on agent_id enforces.
//
// listAgents reads `agents` as the source of truth for identity, name,
// and the most-recently-observed account; LEFT JOINs aggregates from
// agent_transport_sessions and eval_runs grouped by agent_id.

/**
 * Modality enum for the agents view. Derived in SQL from the set of
 * `transport` values observed across the agent's sessions:
 *   - voice  → all transports are audio-bearing (sip, audio_stream)
 *   - text   → all transports are text-bearing (text, terminal_text)
 *   - mixed  → at least one of each
 *   - null   → no sessions yet (e.g. CI-eval-only agent), so unknown
 */
export type Modality = "voice" | "text" | "mixed" | null;

export interface AgentRow {
  /** Stable developer-supplied id — the primary key of the virtual entity.
   * The join between sessions and eval_runs happens on this column. May be
   * null on legacy rows from before producers were updated; the UI surfaces
   * those with an "(unknown id)" badge. */
  agent_id: string | null;
  /** Latest display name observed for this agent. Derived from sessions
   * first (they always carry the human label), falling back to a CI-eval-
   * supplied name if no sessions have shipped one. May be null. */
  agent_name: string | null;
  /** Most-recent account_id observed across either sessions or eval_runs
   * for this agent. An agent that genuinely spans multiple accounts shows
   * its newest; sort breaks ties via last_session_at then last_eval_run_at. */
  account_id: string | null;
  /** What kind of conversations this agent handles, derived from the set
   * of session transports. CI-only agents have null modality until they
   * ship a session. */
  modality: Modality;
  /** Distinct transports observed across this agent's sessions (sorted
   * alphabetically). Empty for agents that only have eval runs. */
  transports: string[];
  // From agent_transport_sessions
  session_count: number;            // total sessions ever
  session_count_24h: number;        // sessions ended in the last 24h
  last_session_at: string | null;   // ISO timestamp
  p95_duration_ms: number | null;
  // From eval_runs
  eval_run_count: number;
  last_eval_run_at: string | null;
  eval_pass_rate: number | null;    // 0..1 over all cases across all runs
}

export interface ListAgentsOpts {
  limit?: number;
  offset?: number;
  accountId?: string | null;
  /** Exact-match filter on agent_id. Used by the agent detail page when
   * looking up a single row. */
  agentId?: string | null;
  /** Free-text case-insensitive substring filter on agent name. */
  agentName?: string | null;
}

/** Internal — escape SQL LIKE metacharacters in user-supplied substrings. */
function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export async function listAgents(
  opts: ListAgentsOpts = {},
): Promise<{ rows: AgentRow[]; total: number }> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const accountId = opts.accountId ?? null;
  const agentId = opts.agentId ?? null;
  const agentName = opts.agentName ?? null;

  // agents table is the entity. LEFT JOIN session aggregates + eval
  // aggregates. An agent that exists in `agents` but has no events yet
  // (rare) still appears with zero counts.
  const agentNameLike = agentName ? `%${escapeLike(agentName.toLowerCase())}%` : null;

  const result = await sql.unsafe(
    `WITH sess AS (
       SELECT
         agent_id,
         COUNT(*)::int AS session_count,
         SUM(CASE WHEN ended_at >= NOW() - INTERVAL '24 hours' THEN 1 ELSE 0 END)::int
           AS session_count_24h,
         MAX(ended_at) AS last_session_at,
         percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_duration_ms,
         -- Modality is the set of transports observed for this agent's
         -- sessions. Mixed = both audio-bearing and text-bearing.
         CASE
           WHEN bool_or(transport IN ('sip', 'audio_stream'))
                AND bool_or(transport IN ('text', 'terminal_text'))
             THEN 'mixed'
           WHEN bool_or(transport IN ('sip', 'audio_stream'))
             THEN 'voice'
           WHEN bool_or(transport IN ('text', 'terminal_text'))
             THEN 'text'
           ELSE NULL
         END AS modality,
         -- All distinct transports observed for this agent. Drives the
         -- transport badges next to the agent header's modality chip.
         (
           SELECT COALESCE(array_agg(t ORDER BY t), ARRAY[]::text[])
           FROM (
             SELECT DISTINCT transport AS t
             FROM agent_transport_sessions s2
             WHERE s2.agent_id = agent_transport_sessions.agent_id
               AND ($1::text IS NULL OR s2.account_id = $1)
               AND transport IS NOT NULL
           ) sub
         ) AS transports
       FROM agent_transport_sessions
       WHERE agent_id IS NOT NULL
         AND ($1::text IS NULL OR account_id = $1)
       GROUP BY agent_id
     ),
     evals AS (
       SELECT
         agent_id,
         COUNT(*)::int AS eval_run_count,
         MAX(started_at) AS last_eval_run_at,
         CASE
           WHEN SUM(total) > 0
             THEN SUM(passed)::float / SUM(total)::float
           ELSE NULL
         END AS eval_pass_rate
       FROM eval_runs
       WHERE agent_id IS NOT NULL
         AND ($1::text IS NULL OR account_id = $1)
       GROUP BY agent_id
     ),
     filtered AS (
       SELECT
         a.agent_id,
         a.account_id,
         a.agent_name,
         sess.modality,
         COALESCE(sess.transports, ARRAY[]::text[]) AS transports,
         COALESCE(sess.session_count,     0) AS session_count,
         COALESCE(sess.session_count_24h, 0) AS session_count_24h,
         sess.last_session_at,
         sess.p95_duration_ms,
         COALESCE(evals.eval_run_count,   0) AS eval_run_count,
         evals.last_eval_run_at,
         evals.eval_pass_rate,
         a.updated_at AS agent_updated_at
       FROM agents a
       LEFT JOIN sess  USING (agent_id)
       LEFT JOIN evals USING (agent_id)
       WHERE ($1::text IS NULL OR a.account_id = $1)
         AND ($2::text IS NULL OR a.agent_id   = $2)
         AND ($3::text IS NULL OR LOWER(COALESCE(a.agent_name, '')) LIKE $3)
     )
     SELECT
       agent_id, account_id, agent_name, modality, transports,
       session_count, session_count_24h, last_session_at, p95_duration_ms,
       eval_run_count, last_eval_run_at, eval_pass_rate,
       (SELECT COUNT(*) FROM filtered)::int AS total_count
     FROM filtered
     ORDER BY agent_updated_at DESC,
              COALESCE(agent_name, agent_id) ASC
     LIMIT $4 OFFSET $5`,
    [accountId, agentId, agentNameLike, limit, offset],
  );

  const total = result.length > 0 ? Number(result[0].total_count) : 0;
  const rows: AgentRow[] = result.map((row: any) => ({
    agent_id: row.agent_id,
    account_id: row.account_id ?? null,
    agent_name: row.agent_name,
    // Cast row.modality (text from Postgres) to the typed enum; the
    // SQL CASE only emits 'voice' | 'text' | 'mixed' | NULL.
    modality: (row.modality ?? null) as Modality,
    transports: Array.isArray(row.transports) ? row.transports : [],
    session_count: row.session_count,
    session_count_24h: row.session_count_24h,
    last_session_at: row.last_session_at ? new Date(row.last_session_at).toISOString() : null,
    p95_duration_ms: row.p95_duration_ms,
    eval_run_count: row.eval_run_count,
    last_eval_run_at: row.last_eval_run_at ? new Date(row.last_eval_run_at).toISOString() : null,
    eval_pass_rate: row.eval_pass_rate != null ? Number(row.eval_pass_rate) : null,
  }));

  return { rows, total };
}

export async function getAgent(
  agentId: string,
  accountId: string | null = null,
): Promise<AgentRow | null> {
  // Look up by composite (agent_id, account_id). If accountId is omitted
  // and the same agent_id exists under multiple accounts, returns the
  // most-recently-active one (matches listAgents' ORDER BY).
  const { rows } = await listAgents({
    agentId,
    accountId,
    limit: 1,
    offset: 0,
  });
  return rows[0] ?? null;
}

// ── Stats (charts) ──────────────────────────────────────────────────────────
//
// One round trip per agent dashboard for the Overview tab. Aggregates that
// need a window-wide scan (sessions per hour, latency percentiles per hour,
// etc.) get computed in SQL so the frontend just plots the bucket array.
//
// Window granularity is fixed at 1 hour for ranges ≤ 7 days and 1 day for
// longer ranges — bucket count stays bounded regardless of range.

export interface AgentStatsBucket {
  bucket_start: string;        // ISO timestamp at the bucket's leading edge
  session_count: number;
  avg_duration_ms: number | null;
  p95_user_perceived_ms: number | null;
  /** Per-bucket sum of `agent_transport_sessions.estimated_cost_usd`.
   *  Pre-aggregated server-side using the same priceFor() path eval-runs
   *  use, then summed across the bucket's sessions. Null when no session
   *  in the bucket carried a priceable usage record. */
  estimated_cost_usd: number | null;
}

export interface AgentStats {
  range: string;                 // '24h' | '7d' | '30d'
  total_sessions: number;
  /** Window-wide sum of `estimated_cost_usd`. Null when no session in the
   *  window carried priceable usage. Drives the Sessions tab's Total
   *  Cost KPI tile and sparkline. */
  total_estimated_cost_usd: number | null;
  avg_turn_count: number | null;
  p50_user_perceived_ms: number | null;
  p95_user_perceived_ms: number | null;
  p99_user_perceived_ms: number | null;
  llm_pass_rate: number | null;  // 0..1 over session_external_evals rows
  ci_pass_rate: number | null;   // 0..1 over CI eval cases
  buckets: AgentStatsBucket[];
  transport_breakdown: Array<{ transport: string | null; count: number }>;
  provider_breakdown: Array<{ provider: string; model: string; count: number }>;
}

// `interval` feeds NOW() - $::interval and accepts the natural plural
// form. `bucket` feeds date_trunc(), which takes the unit name only —
// "hour"/"day" rather than "1 hour"/"1 day".
const RANGE_TO_INTERVAL: Record<string, { interval: string; bucket: string }> = {
  "24h": { interval: "24 hours", bucket: "hour" },
  "7d":  { interval: "7 days",   bucket: "hour" },
  "30d": { interval: "30 days",  bucket: "day" },
};

export async function getAgentStats(
  agentId: string,
  range = "24h",
  accountId: string | null = null,
): Promise<AgentStats> {
  const { interval, bucket } = RANGE_TO_INTERVAL[range] ?? RANGE_TO_INTERVAL["24h"];
  // Account-scope predicate is inlined per query (parameter slot varies).
  // accountId === null bypasses the predicate so a single-account lookup
  // and an all-accounts rollup share the same code path.

  // Helper inline expression: jsonb_array_elements blows up on NULL or
  // non-array values, so we guard with jsonb_typeof before unpacking. The
  // pattern repeats across the bucket / totals / provider queries.
  const PER_TURN_ELEMS = (col: string) => `
    jsonb_array_elements(
      CASE WHEN jsonb_typeof(${col}->'per_turn') = 'array'
           THEN ${col}->'per_turn'
           ELSE '[]'::jsonb
      END
    )
  `;

  const [bucketRows, totalsRow, providerRows, transportRows] = await Promise.all([
    // Per-bucket aggregates.
    //
    // Three CTE layers so we don't have to push a correlated subquery
    // through a GROUP BY:
    //   1. `win`            — raw sessions in the window
    //   2. `session_buckets`— per-bucket session counts + durations
    //   3. `turn_buckets`   — per-bucket p95 perceived latency from per_turn[]
    // LEFT JOIN the two bucket tables so a bucket with sessions but no
    // numeric per-turn metrics still appears (p95 = NULL).
    sql.unsafe(
      `WITH win AS (
         SELECT id, ended_at, duration_ms, session_metrics, estimated_cost_usd
         FROM agent_transport_sessions
         WHERE agent_id = $1
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
         -- Perceived latency: e2e_latency is the audio-pipeline measure
         -- (STT→LLM→TTS round trip). Text-only sessions have no e2e_latency
         -- field on per-turn metrics — they only carry llm_node_ttft — so
         -- fall back to that. Same fallback metrics.ts uses on the read
         -- path; without it, text-mode agents show an empty p95 chart on
         -- the Overview tab even though we have the latency data.
         SELECT
           date_trunc($3, win.ended_at) AS bucket,
           COALESCE(
             NULLIF(m->>'e2e_latency', '')::float,
             NULLIF(m->>'llm_node_ttft', '')::float
           ) * 1000 AS perceived_ms
         FROM win, ${PER_TURN_ELEMS('win.session_metrics')} AS m
         WHERE (m->>'e2e_latency') ~ '^[0-9.]+$'
            OR (m->>'llm_node_ttft') ~ '^[0-9.]+$'
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
    // Window totals — same pattern. The CTEs are referenced via scalar
    // subqueries in a SELECT with no FROM clause; that's valid SQL.
    sql.unsafe(
      `WITH win AS (
         SELECT id, session_id, session_metrics, turn_count, estimated_cost_usd
         FROM agent_transport_sessions
         WHERE agent_id = $1
           AND ended_at >= NOW() - $2::interval
           AND ($3::text IS NULL OR account_id = $3)
       ),
       turns AS (
         -- See bucket query above for the e2e_latency vs llm_node_ttft
         -- fallback rationale (text-only sessions only carry the latter).
         SELECT COALESCE(
                  NULLIF(m->>'e2e_latency', '')::float,
                  NULLIF(m->>'llm_node_ttft', '')::float
                ) * 1000 AS perceived_ms
         FROM win, ${PER_TURN_ELEMS('win.session_metrics')} AS m
         WHERE (m->>'e2e_latency') ~ '^[0-9.]+$'
            OR (m->>'llm_node_ttft') ~ '^[0-9.]+$'
       )
       SELECT
         (SELECT COUNT(*) FROM win)::int AS total_sessions,
         (SELECT SUM(estimated_cost_usd) FROM win)::float AS total_estimated_cost_usd,
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
             WHEN SUM(total) = 0 THEN NULL
             ELSE SUM(passed)::float / SUM(total)::float
           END
           FROM eval_runs
           WHERE agent_id = $1
             AND started_at >= NOW() - $2::interval
             AND ($3::text IS NULL OR account_id = $3)
         ) AS ci_pass_rate`,
      [agentId, interval, accountId],
    ),
    // Provider breakdown — count turn occurrences per provider/model.
    sql.unsafe(
      `WITH win AS (
         SELECT session_metrics
         FROM agent_transport_sessions
         WHERE agent_id = $1 AND ended_at >= NOW() - $2::interval
           AND ($3::text IS NULL OR account_id = $3)
       ),
       turns AS (
         SELECT m->'llm_metadata'->>'model_provider' AS provider,
                m->'llm_metadata'->>'model_name'      AS model
         FROM win, ${PER_TURN_ELEMS('win.session_metrics')} AS m
       )
       SELECT provider, model, COUNT(*)::int AS count
       FROM turns
       WHERE provider IS NOT NULL
       GROUP BY provider, model
       ORDER BY count DESC
       LIMIT 8`,
      [agentId, interval, accountId],
    ),
    // Transport breakdown
    sql.unsafe(
      `SELECT transport, COUNT(*)::int AS count
       FROM agent_transport_sessions
       WHERE agent_id = $1 AND ended_at >= NOW() - $2::interval
         AND ($3::text IS NULL OR account_id = $3)
       GROUP BY transport
       ORDER BY count DESC`,
      [agentId, interval, accountId],
    ),
  ]);

  const totals = totalsRow[0] ?? {};

  return {
    range,
    total_sessions: totals.total_sessions ?? 0,
    total_estimated_cost_usd: totals.total_estimated_cost_usd != null
      ? Number(totals.total_estimated_cost_usd)
      : null,
    avg_turn_count: totals.avg_turn_count != null ? Number(totals.avg_turn_count) : null,
    p50_user_perceived_ms: totals.p50_user_perceived_ms,
    p95_user_perceived_ms: totals.p95_user_perceived_ms,
    p99_user_perceived_ms: totals.p99_user_perceived_ms,
    llm_pass_rate: totals.llm_pass_rate != null ? Number(totals.llm_pass_rate) : null,
    ci_pass_rate:  totals.ci_pass_rate  != null ? Number(totals.ci_pass_rate)  : null,
    buckets: bucketRows.map((r: any) => ({
      bucket_start: r.bucket_start,
      session_count: r.session_count,
      avg_duration_ms: r.avg_duration_ms,
      p95_user_perceived_ms: r.p95_user_perceived_ms,
      estimated_cost_usd: r.estimated_cost_usd != null ? Number(r.estimated_cost_usd) : null,
    })),
    transport_breakdown: transportRows.map((r: any) => ({
      transport: r.transport,
      count: r.count,
    })),
    provider_breakdown: providerRows.map((r: any) => ({
      provider: r.provider,
      model: r.model ?? '',
      count: r.count,
    })),
  };
}

// ── Conversation evals ──────────────────────────────────────────────────────
//
// One row per session for an agent, with the same eval/tag/outcome data
// the session-detail drawer renders, summarised for tabular display:
//
//   - Counts of pass / fail / maybe verdicts in session_external_evals
//   - Distinct judge names (so the table can render chips per judge)
//   - Outcome name + reason if session_outcomes has a row
//   - The full `evaluations` and `tags` arrays so the row can drill-in
//     without a second round-trip
//
// Filters by (agent_id, optional account_id) to match the agents view's
// composite key. Sessions without any eval / outcome / non-routing tag
// are excluded so the tab only shows sessions that have something to
// show.

export interface ConversationEvalSummary {
  session_id: string;
  account_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  ended_at: string;
  duration_ms: number | null;
  pass_count: number;
  fail_count: number;
  maybe_count: number;
  judge_names: string[];
  outcome: string | null;
  outcome_reason: string | null;
  evaluations: Array<Record<string, unknown>>;
}

export interface ListConversationEvalsOpts {
  agentId: string;
  accountId?: string | null;
  limit?: number;
  offset?: number;
  /** Free-text case-insensitive substring filter on `session_id`. */
  sessionId?: string | null;
  /** When true, restrict results to sessions with at least one
   *  failing external eval verdict or a session_outcomes row whose
   *  outcome is "fail" / "lk.fail". */
  failedOnly?: boolean;
}

export async function listConversationEvals(
  opts: ListConversationEvalsOpts,
): Promise<{ rows: ConversationEvalSummary[]; total: number }> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const accountId = opts.accountId ?? null;
  // Escape `%` / `_` / `\` so a user-typed underscore in the search box
  // doesn't get interpreted as a LIKE wildcard. Mirrors how listAgents +
  // listEvalRuns handle their substring filters.
  const sessionIdLike = opts.sessionId && opts.sessionId.length > 0
    ? `%${escapeLike(opts.sessionId.toLowerCase())}%`
    : null;
  const failedOnly = opts.failedOnly === true;

  // The base set: sessions for the agent that have at least one related
  // row in session_external_evals or session_outcomes. We use EXISTS
  // rather than JOIN to avoid duplicating session rows when an agent has
  // many evals on the same session.
  const result = await sql.unsafe(
    `WITH base AS (
       SELECT s.session_id, s.account_id, s.agent_id, s.agent_name,
              s.ended_at, s.duration_ms
       FROM agent_transport_sessions s
       WHERE s.agent_id = $1
         AND ($2::text IS NULL OR s.account_id = $2)
         AND ($5::text IS NULL OR LOWER(s.session_id) LIKE $5)
         AND (
           EXISTS (SELECT 1 FROM session_external_evals e
                   WHERE e.session_id = s.session_id)
           OR
           EXISTS (SELECT 1 FROM session_outcomes o
                   WHERE o.session_id = s.session_id)
         )
         AND (
           $6::bool = FALSE
           OR EXISTS (SELECT 1 FROM session_external_evals e
                      WHERE e.session_id = s.session_id AND e.verdict = 'fail')
           OR EXISTS (SELECT 1 FROM session_outcomes o
                      WHERE o.session_id = s.session_id
                        AND o.outcome IN ('lk.fail', 'fail'))
         )
     ),
     paged AS (
       SELECT * FROM base
       ORDER BY ended_at DESC
       LIMIT $3 OFFSET $4
     ),
     ev AS (
       SELECT session_id,
              COUNT(*) FILTER (WHERE verdict = 'pass')::int  AS pass_count,
              COUNT(*) FILTER (WHERE verdict = 'fail')::int  AS fail_count,
              COUNT(*) FILTER (WHERE verdict = 'maybe')::int AS maybe_count,
              array_agg(DISTINCT judge_name)                 AS judge_names,
              -- Full eval rows for drill-in. NULL-safe: jsonb_agg keeps
              -- the JSONB shape even when raw is text in storage.
              jsonb_agg(jsonb_build_object(
                'source',       source,
                'judge_name',   judge_name,
                'tag',          tag,
                'verdict',      verdict,
                'reasoning',    reasoning,
                'instructions', instructions,
                'observed_at',  observed_at,
                'raw',          CASE WHEN jsonb_typeof(raw) IS NOT NULL THEN raw ELSE NULL END,
                'created_at',   created_at
              ) ORDER BY COALESCE(observed_at, created_at) ASC) AS evaluations
       FROM session_external_evals
       WHERE session_id IN (SELECT session_id FROM paged)
       GROUP BY session_id
     ),
     oc AS (
       SELECT DISTINCT ON (session_id)
              session_id, outcome, reason AS outcome_reason
       FROM session_outcomes
       WHERE session_id IN (SELECT session_id FROM paged)
       ORDER BY session_id, COALESCE(observed_at, updated_at, created_at) DESC
     )
     SELECT p.session_id,
            p.account_id,
            p.agent_id,
            p.agent_name,
            p.ended_at,
            p.duration_ms,
            COALESCE(ev.pass_count,  0) AS pass_count,
            COALESCE(ev.fail_count,  0) AS fail_count,
            COALESCE(ev.maybe_count, 0) AS maybe_count,
            COALESCE(ev.judge_names, ARRAY[]::text[]) AS judge_names,
            oc.outcome,
            oc.outcome_reason,
            COALESCE(ev.evaluations, '[]'::jsonb) AS evaluations,
            (SELECT COUNT(*) FROM base)::int AS total_count
     FROM paged p
     LEFT JOIN ev USING (session_id)
     LEFT JOIN oc USING (session_id)
     ORDER BY p.ended_at DESC`,
    [opts.agentId, accountId, limit, offset, sessionIdLike, failedOnly],
  );

  const total = result.length > 0 ? Number(result[0].total_count) : 0;
  const rows: ConversationEvalSummary[] = result.map((row: any) => ({
    session_id: row.session_id,
    account_id: row.account_id ?? null,
    agent_id: row.agent_id ?? null,
    agent_name: row.agent_name ?? null,
    ended_at: new Date(row.ended_at).toISOString(),
    duration_ms: row.duration_ms,
    pass_count: row.pass_count,
    fail_count: row.fail_count,
    maybe_count: row.maybe_count,
    judge_names: row.judge_names ?? [],
    outcome: row.outcome ?? null,
    outcome_reason: row.outcome_reason ?? null,
    evaluations: typeof row.evaluations === 'string'
      ? JSON.parse(row.evaluations)
      : row.evaluations ?? [],
  }));

  return { rows, total };
}
