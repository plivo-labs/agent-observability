import { sql } from "../db.js";
import { upsertAgentTx } from "../agents/upsert.js";
import { escapeLikePattern } from "../response.js";
import type {
  EvalCase,
  EvalPayloadV0,
  CaseStatus,
} from "./schema.js";
import { summarize } from "./summarize.js";
import { deriveRunStatus } from "./overlay.js";
import { computeCaseMetrics } from "./metrics.js";
import { ensurePricesLoaded } from "./pricing.js";
export { deriveRunStatus, EVAL_RUN_STALE_ACTIVITY_MS } from "./overlay.js";
export { summarize } from "./summarize.js";
export type { RunSummary } from "./summarize.js";

// Tracks run_ids that already have a stale → completed UPDATE in flight,
// so a single page-load with N stale rows doesn't fan out into N
// duplicate UPDATEs against the same id (and lets retries spread out
// naturally as new reads roll in). Entries clear in the `.finally`.
const inFlightStaleUpdates = new Set<string>();

/** Fire-and-forget: when the read overlay detects a stale 'running' row,
 * push a background UPDATE so the stored status eventually agrees with
 * the overlayed view. Doesn't block the read response — errors are
 * logged but never propagate. */
function queueStaleStatusUpdate(runId: string): void {
  if (inFlightStaleUpdates.has(runId)) return;
  inFlightStaleUpdates.add(runId);
  // `AND status = 'running'` guards against races (another reader or
  // a terminal POST may have already flipped the row).
  sql`
    UPDATE eval_runs
       SET status = 'completed'
     WHERE run_id = ${runId}::uuid
       AND status = 'running'
  `
    .then(() => undefined)
    .catch((e: Error) =>
      console.error(
        `[evals] background stale flip failed run_id=${runId}: ${e.message}`,
      ),
    )
    .finally(() => inFlightStaleUpdates.delete(runId));
}

// Bun's SQL driver returns Postgres BIGINT as strings (to avoid JS
// integer-precision loss on >2^53 values). All of our BIGINT counters
// fit comfortably in `number` range, so coerce them at the read
// boundary — keeps downstream code from having to guard
// `Number.isFinite('55238') === false` everywhere.
const BIGINT_FIELDS = [
  "duration_ms",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "cached_prompt_tokens",
] as const;

function coerceBigintFields<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const k of BIGINT_FIELDS) {
    const v = out[k];
    if (typeof v === "string" && v.length > 0) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out as T;
}

function applyStatusOverlay<
  T extends {
    run_id?: unknown;
    status?: unknown;
    last_activity_at?: unknown;
  },
>(row: T): T {
  const stored = row.status as string;
  const effective = deriveRunStatus(stored, row.last_activity_at as any);
  if (effective !== stored && stored === "running") {
    const runId = row.run_id as string | undefined;
    if (typeof runId === "string" && runId.length > 0) {
      // Async catch-up — doesn't block the read response.
      queueStaleStatusUpdate(runId);
    }
  }
  return coerceBigintFields({ ...row, status: effective });
}

// ── Insert ──────────────────────────────────────────────────────────────────

export async function insertEvalRun(payload: EvalPayloadV0): Promise<void> {
  const { run, cases } = payload;
  const summary = summarize(cases);

  // Make sure the in-memory pricing map is loaded (models.dev fetch
  // happens at most every 6h; this is cheap after the first call).
  // Best-effort — if the fetch fails the static seed table still
  // covers the common cases and cost falls back to null otherwise.
  await ensurePricesLoaded();

  const startedAt = new Date(run.started_at * 1000);
  // finished_at is null for in-flight 'running' runs (session-start POST).
  const finishedAt = run.finished_at != null ? new Date(run.finished_at * 1000) : null;
  const durationMs =
    run.finished_at != null
      ? Math.max(0, Math.round((run.finished_at - run.started_at) * 1000))
      : null;
  const status = run.status ?? "completed";

  // Run-level metrics (latency + token usage) computed across the
  // flat events array from ALL cases — keeps p50/p95 representative
  // of the actual sample distribution, and token sums are exact. On
  // the running POST (cases=[]) this collapses to nulls + zeros,
  // which the terminal POST overwrites via ON CONFLICT EXCLUDED.x
  // below.
  const runMetrics = computeCaseMetrics(
    cases.flatMap((c) => (c.events as unknown[]) ?? []),
  );

  await sql.begin(async (tx: any) => {
    // Upsert the agent first so the FK on eval_runs.agent_id is
    // satisfied. Skipped when no agent_id was supplied.
    if (run.agent_id) {
      await upsertAgentTx(tx, {
        agentId: run.agent_id,
        accountId: run.account_id,
        agentName: run.agent_name ?? null,
      });
    }
    // ON CONFLICT (run_id) DO UPDATE — the streaming flow POSTs twice
    // for the same run_id: once with status='running' at session-start,
    // again at session-finish with the exitstatus-derived status. The
    // terminal POST overwrites mutable fields; immutable identity
    // fields stay put. COALESCE on the optional fields preserves
    // earlier non-null values if the terminal POST omits them.
    //
    // last_activity_at is server-managed — set to NOW() on every write
    // so the read overlay can flip long-stale 'running' rows (older
    // than EVAL_RUN_STALE_ACTIVITY_MS) to 'completed' for hard-kill
    // cleanup.
    await tx`
      INSERT INTO eval_runs (
        run_id, name, account_id, agent_id,
        framework, framework_version,
        testing_framework, testing_framework_version,
        started_at, finished_at, duration_ms,
        total, passed, failed, errored, skipped,
        ci, status, last_activity_at,
        ttft_p50_ms, ttft_p95_ms, ttft_avg_ms,
        ttfb_p50_ms, ttfb_p95_ms, ttfb_avg_ms,
        turn_count, tool_call_count, interruption_count,
        agent_handoff_count, ttft_sample_count,
        prompt_tokens, completion_tokens, total_tokens, cached_prompt_tokens,
        estimated_cost_usd
      ) VALUES (
        ${run.run_id},
        ${run.name ?? null},
        ${run.account_id ?? null},
        ${run.agent_id ?? null},
        ${run.framework ?? null},
        ${run.framework_version ?? null},
        ${run.testing_framework},
        ${run.testing_framework_version ?? null},
        ${startedAt},
        ${finishedAt},
        ${durationMs},
        ${summary.total},
        ${summary.passed},
        ${summary.failed},
        ${summary.errored},
        ${summary.skipped},
        ${run.ci != null ? JSON.stringify(run.ci) : null}::jsonb,
        ${status},
        NOW(),
        ${runMetrics.ttft_p50_ms},
        ${runMetrics.ttft_p95_ms},
        ${runMetrics.ttft_avg_ms},
        ${runMetrics.ttfb_p50_ms},
        ${runMetrics.ttfb_p95_ms},
        ${runMetrics.ttfb_avg_ms},
        ${runMetrics.turn_count},
        ${runMetrics.tool_call_count},
        ${runMetrics.interruption_count},
        ${runMetrics.agent_handoff_count},
        ${runMetrics.ttft_sample_count},
        ${runMetrics.prompt_tokens},
        ${runMetrics.completion_tokens},
        ${runMetrics.total_tokens},
        ${runMetrics.cached_prompt_tokens},
        ${runMetrics.estimated_cost_usd}
      )
      ON CONFLICT (run_id) DO UPDATE SET
        name                = COALESCE(EXCLUDED.name,              eval_runs.name),
        status              = EXCLUDED.status,
        finished_at         = COALESCE(EXCLUDED.finished_at,       eval_runs.finished_at),
        duration_ms         = COALESCE(EXCLUDED.duration_ms,       eval_runs.duration_ms),
        total               = EXCLUDED.total,
        passed              = EXCLUDED.passed,
        failed              = EXCLUDED.failed,
        errored             = EXCLUDED.errored,
        skipped             = EXCLUDED.skipped,
        last_activity_at    = NOW(),
        ci                  = COALESCE(EXCLUDED.ci,                eval_runs.ci),
        account_id          = COALESCE(EXCLUDED.account_id,        eval_runs.account_id),
        agent_id            = COALESCE(EXCLUDED.agent_id,          eval_runs.agent_id),
        framework           = COALESCE(EXCLUDED.framework,         eval_runs.framework),
        framework_version   = COALESCE(EXCLUDED.framework_version, eval_runs.framework_version),
        testing_framework_version =
          COALESCE(EXCLUDED.testing_framework_version, eval_runs.testing_framework_version),
        -- Latency + token metrics: the terminal POST is authoritative.
        -- Running POST (cases=[]) computes nulls/zeros, so EXCLUDED.x
        -- always wins from the side with real samples. Edge race "late
        -- running POST after terminal" temporarily blanks the row;
        -- accepted as theoretical-only.
        ttft_p50_ms          = EXCLUDED.ttft_p50_ms,
        ttft_p95_ms          = EXCLUDED.ttft_p95_ms,
        ttft_avg_ms          = EXCLUDED.ttft_avg_ms,
        ttfb_p50_ms          = EXCLUDED.ttfb_p50_ms,
        ttfb_p95_ms          = EXCLUDED.ttfb_p95_ms,
        ttfb_avg_ms          = EXCLUDED.ttfb_avg_ms,
        turn_count           = EXCLUDED.turn_count,
        tool_call_count      = EXCLUDED.tool_call_count,
        interruption_count   = EXCLUDED.interruption_count,
        agent_handoff_count  = EXCLUDED.agent_handoff_count,
        ttft_sample_count    = EXCLUDED.ttft_sample_count,
        prompt_tokens        = EXCLUDED.prompt_tokens,
        completion_tokens    = EXCLUDED.completion_tokens,
        total_tokens         = EXCLUDED.total_tokens,
        cached_prompt_tokens = EXCLUDED.cached_prompt_tokens,
        estimated_cost_usd   = EXCLUDED.estimated_cost_usd
    `;

    for (const c of cases) {
      const caseDurationMs = c.duration_ms
        ?? (c.started_at != null && c.finished_at != null
          ? Math.max(0, Math.round((c.finished_at - c.started_at) * 1000))
          : null);
      const caseMetrics = computeCaseMetrics((c.events as unknown[]) ?? []);

      // ON CONFLICT (case_id) DO NOTHING — cases are terminal records.
      // Cases only arrive in the terminal POST, but idempotency here
      // keeps any client re-upload safe.
      await tx`
        INSERT INTO eval_cases (
          case_id, run_id, name, file, status, duration_ms,
          user_input, events, judgments, failure,
          ttft_p50_ms, ttft_p95_ms, ttft_avg_ms,
          ttfb_p50_ms, ttfb_p95_ms, ttfb_avg_ms,
          turn_count, tool_call_count, interruption_count,
          agent_handoff_count, ttft_sample_count,
          prompt_tokens, completion_tokens, total_tokens, cached_prompt_tokens,
          estimated_cost_usd
        ) VALUES (
          ${c.case_id},
          ${run.run_id},
          ${c.name},
          ${c.file ?? null},
          ${c.status},
          ${caseDurationMs},
          ${c.user_input ?? null},
          ${JSON.stringify(c.events ?? [])}::jsonb,
          ${JSON.stringify(c.judgments ?? [])}::jsonb,
          ${c.failure != null ? JSON.stringify(c.failure) : null}::jsonb,
          ${caseMetrics.ttft_p50_ms},
          ${caseMetrics.ttft_p95_ms},
          ${caseMetrics.ttft_avg_ms},
          ${caseMetrics.ttfb_p50_ms},
          ${caseMetrics.ttfb_p95_ms},
          ${caseMetrics.ttfb_avg_ms},
          ${caseMetrics.turn_count},
          ${caseMetrics.tool_call_count},
          ${caseMetrics.interruption_count},
          ${caseMetrics.agent_handoff_count},
          ${caseMetrics.ttft_sample_count},
          ${caseMetrics.prompt_tokens},
          ${caseMetrics.completion_tokens},
          ${caseMetrics.total_tokens},
          ${caseMetrics.cached_prompt_tokens},
          ${caseMetrics.estimated_cost_usd}
        )
        ON CONFLICT (case_id) DO NOTHING
      `;
    }

    // Recompute run-level aggregates from eval_cases. Lets the streaming
    // flusher POST partial payloads (cases=[newly finished N]) without
    // clobbering the totals — each call adds N case rows and this UPDATE
    // re-derives the run-level fields from whatever's now in the table.
    //
    // Tally fields (total/passed/failed/errored/skipped) are exact counts.
    // Token/usage sums and counters are exact (just SUM over per-case
    // columns from S5 and S4). Latency p50/p95/avg are *approximated*
    // by AVG of per-case percentiles — not statistically equivalent to a
    // proper percentile over the raw sample distribution, but a
    // reasonable proxy that stays cheap (no scan of events JSONB).
    // The final session-finish POST overwrites the per-case columns
    // with full-events numbers (via the case INSERTs), so by the time
    // the run is `completed` these run-level fields reflect terminal
    // data — just possibly via a slightly biased aggregation for the
    // percentiles.
    //
    // Cost preserves the "null when any priced sample is unpriced"
    // contract from summarizeUsage (S6) — if any case row has tokens
    // but no estimated_cost_usd, the run-level cost is NULL.
    await tx`
      WITH agg AS (
        SELECT
          COUNT(*)::int                                            AS c_total,
          COUNT(*) FILTER (WHERE status = 'passed')::int           AS c_passed,
          COUNT(*) FILTER (WHERE status = 'failed')::int           AS c_failed,
          COUNT(*) FILTER (WHERE status = 'errored')::int          AS c_errored,
          COUNT(*) FILTER (WHERE status = 'skipped')::int          AS c_skipped,
          COALESCE(SUM(prompt_tokens), 0)::bigint                  AS c_prompt,
          COALESCE(SUM(cached_prompt_tokens), 0)::bigint           AS c_cached,
          COALESCE(SUM(completion_tokens), 0)::bigint              AS c_completion,
          COALESCE(SUM(total_tokens), 0)::bigint                   AS c_total_tokens,
          COALESCE(SUM(turn_count), 0)::int                        AS c_turns,
          COALESCE(SUM(tool_call_count), 0)::int                   AS c_tools,
          COALESCE(SUM(interruption_count), 0)::int                AS c_intr,
          COALESCE(SUM(agent_handoff_count), 0)::int               AS c_handoff,
          COALESCE(SUM(ttft_sample_count), 0)::int                 AS c_ttft_samples,
          CASE
            WHEN COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL AND total_tokens > 0) > 0
              THEN NULL
            ELSE COALESCE(SUM(estimated_cost_usd), 0)
          END                                                       AS c_cost,
          CASE WHEN COUNT(*) FILTER (WHERE ttft_avg_ms IS NOT NULL) = 0 THEN NULL
               ELSE ROUND(AVG(ttft_avg_ms))::int END                AS c_ttft_avg,
          CASE WHEN COUNT(*) FILTER (WHERE ttft_p50_ms IS NOT NULL) = 0 THEN NULL
               ELSE ROUND(AVG(ttft_p50_ms))::int END                AS c_ttft_p50,
          CASE WHEN COUNT(*) FILTER (WHERE ttft_p95_ms IS NOT NULL) = 0 THEN NULL
               ELSE ROUND(AVG(ttft_p95_ms))::int END                AS c_ttft_p95,
          CASE WHEN COUNT(*) FILTER (WHERE ttfb_avg_ms IS NOT NULL) = 0 THEN NULL
               ELSE ROUND(AVG(ttfb_avg_ms))::int END                AS c_ttfb_avg,
          CASE WHEN COUNT(*) FILTER (WHERE ttfb_p50_ms IS NOT NULL) = 0 THEN NULL
               ELSE ROUND(AVG(ttfb_p50_ms))::int END                AS c_ttfb_p50,
          CASE WHEN COUNT(*) FILTER (WHERE ttfb_p95_ms IS NOT NULL) = 0 THEN NULL
               ELSE ROUND(AVG(ttfb_p95_ms))::int END                AS c_ttfb_p95
        FROM eval_cases
        WHERE run_id = ${run.run_id}::uuid
      )
      UPDATE eval_runs SET
        total                = agg.c_total,
        passed               = agg.c_passed,
        failed               = agg.c_failed,
        errored              = agg.c_errored,
        skipped              = agg.c_skipped,
        prompt_tokens        = agg.c_prompt,
        cached_prompt_tokens = agg.c_cached,
        completion_tokens    = agg.c_completion,
        total_tokens         = agg.c_total_tokens,
        turn_count           = agg.c_turns,
        tool_call_count      = agg.c_tools,
        interruption_count   = agg.c_intr,
        agent_handoff_count  = agg.c_handoff,
        ttft_sample_count    = agg.c_ttft_samples,
        estimated_cost_usd   = agg.c_cost,
        ttft_avg_ms          = agg.c_ttft_avg,
        ttft_p50_ms          = agg.c_ttft_p50,
        ttft_p95_ms          = agg.c_ttft_p95,
        ttfb_avg_ms          = agg.c_ttfb_avg,
        ttfb_p50_ms          = agg.c_ttfb_p50,
        ttfb_p95_ms          = agg.c_ttfb_p95
      FROM agg
      WHERE run_id = ${run.run_id}::uuid
    `;
  });
}

// ── Queries ─────────────────────────────────────────────────────────────────

export interface ListEvalRunsOpts {
  limit: number;
  offset: number;
  accountId?: string | null;
  agentId?: string | null;
  /** Multi-value — `framework IN (...)` when non-empty. Filters on the
   *  agent framework (`livekit` / `pipecat` / …). */
  frameworks?: string[] | null;
  /** Multi-value — `testing_framework IN (...)` when non-empty. Filters
   *  on the test framework (`pytest` / `vitest` / …). */
  testingFrameworks?: string[] | null;
  startedFrom?: string | null;
  startedTo?: string | null;
}

export async function countEvalRuns(opts: ListEvalRunsOpts): Promise<number> {
  const { predicates, params } = buildPredicates(opts);
  const whereClause = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const [row] = await sql.unsafe(
    `SELECT count(*)::int AS total FROM eval_runs r ${whereClause}`,
    params,
  );
  return row.total;
}

const RUN_SELECT_COLS =
  "r.run_id, r.name, r.account_id, r.agent_id, a.agent_name, " +
  "r.framework, r.framework_version, r.testing_framework, r.testing_framework_version, " +
  "r.started_at, r.finished_at, r.duration_ms, " +
  "r.total, r.passed, r.failed, r.errored, r.skipped, " +
  "r.ci, r.status, r.last_activity_at, r.created_at, " +
  "r.ttft_p50_ms, r.ttft_p95_ms, r.ttft_avg_ms, " +
  "r.ttfb_p50_ms, r.ttfb_p95_ms, r.ttfb_avg_ms, " +
  "r.turn_count, r.tool_call_count, r.interruption_count, " +
  "r.agent_handoff_count, r.ttft_sample_count, " +
  "r.prompt_tokens, r.completion_tokens, r.total_tokens, r.cached_prompt_tokens, " +
  "r.estimated_cost_usd";

export async function listEvalRuns(opts: ListEvalRunsOpts): Promise<any[]> {
  const { predicates, params } = buildPredicates(opts);
  const whereClause = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const rows = await sql.unsafe(
    `SELECT ${RUN_SELECT_COLS}
     FROM eval_runs r
     LEFT JOIN agents a ON a.agent_id = r.agent_id
     ${whereClause}
     ORDER BY r.started_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, opts.limit, opts.offset],
  );
  return rows.map(applyStatusOverlay);
}

export async function getEvalRun(runId: string): Promise<any | null> {
  const rows = await sql.unsafe(
    `SELECT ${RUN_SELECT_COLS}
     FROM eval_runs r
     LEFT JOIN agents a ON a.agent_id = r.agent_id
     WHERE r.run_id = $1
     LIMIT 1`,
    [runId],
  );
  return rows[0] ? applyStatusOverlay(rows[0]) : null;
}

export async function listEvalCases(runId: string): Promise<any[]> {
  const rows = await sql`
    SELECT case_id, run_id, name, file, status, duration_ms, user_input,
           events, judgments, failure, created_at,
           ttft_p50_ms, ttft_p95_ms, ttft_avg_ms,
           ttfb_p50_ms, ttfb_p95_ms, ttfb_avg_ms,
           turn_count, tool_call_count, interruption_count,
           agent_handoff_count, ttft_sample_count,
           prompt_tokens, completion_tokens, total_tokens, cached_prompt_tokens,
           estimated_cost_usd
    FROM eval_cases
    WHERE run_id = ${runId}
    ORDER BY created_at ASC
  `;
  return rows.map(decodeCaseJsonb);
}

export async function getEvalCase(runId: string, caseId: string): Promise<any | null> {
  const rows = await sql`
    SELECT case_id, run_id, name, file, status, duration_ms, user_input,
           events, judgments, failure, created_at,
           ttft_p50_ms, ttft_p95_ms, ttft_avg_ms,
           ttfb_p50_ms, ttfb_p95_ms, ttfb_avg_ms,
           turn_count, tool_call_count, interruption_count,
           agent_handoff_count, ttft_sample_count,
           prompt_tokens, completion_tokens, total_tokens, cached_prompt_tokens,
           estimated_cost_usd
    FROM eval_cases
    WHERE run_id = ${runId} AND case_id = ${caseId}
    LIMIT 1
  `;
  return rows[0] ? decodeCaseJsonb(rows[0]) : null;
}

// `eval_cases.run_id` has ON DELETE CASCADE, so deleting runs cleans
// up their cases automatically.
export async function deleteEvalRuns(runIds: string[]): Promise<number> {
  if (runIds.length === 0) return 0;
  // `${runIds}::uuid[]` would let Bun stringify the array as a CSV which
  // Postgres rejects ("malformed array literal"). Bind each id as its own
  // ::uuid placeholder via sql.unsafe, the same pattern the list filters use.
  const placeholders = runIds.map((_, i) => `$${i + 1}::uuid`).join(", ");
  const rows = await sql.unsafe(
    `DELETE FROM eval_runs
     WHERE run_id IN (${placeholders})
     RETURNING run_id`,
    runIds,
  );
  return rows.length;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildPredicates(opts: ListEvalRunsOpts): { predicates: string[]; params: unknown[] } {
  const predicates: string[] = [];
  const params: unknown[] = [];
  // Free-text filters use lower-cased substring LIKE — case-insensitive,
  // forgiving of partial matches. Loses index usage on `account_id` /
  // `agent_id`; revisit with a pg_trgm GIN index if filter latency
  // matters at higher row counts.
  if (opts.accountId) {
    predicates.push(`LOWER(r.account_id) LIKE $${params.length + 1}`);
    params.push(`%${escapeLikePattern(opts.accountId.toLowerCase())}%`);
  }
  if (opts.agentId) {
    predicates.push(`LOWER(r.agent_id) LIKE $${params.length + 1}`);
    params.push(`%${escapeLikePattern(opts.agentId.toLowerCase())}%`);
  }
  if (opts.frameworks && opts.frameworks.length > 0) {
    const placeholders = opts.frameworks.map(
      (_, i) => `$${params.length + i + 1}`,
    );
    predicates.push(`r.framework IN (${placeholders.join(", ")})`);
    params.push(...opts.frameworks);
  }
  if (opts.testingFrameworks && opts.testingFrameworks.length > 0) {
    const placeholders = opts.testingFrameworks.map(
      (_, i) => `$${params.length + i + 1}`,
    );
    predicates.push(`r.testing_framework IN (${placeholders.join(", ")})`);
    params.push(...opts.testingFrameworks);
  }
  if (opts.startedFrom) {
    predicates.push(`r.started_at >= $${params.length + 1}`);
    params.push(opts.startedFrom);
  }
  if (opts.startedTo) {
    predicates.push(`r.started_at <= $${params.length + 1}`);
    params.push(opts.startedTo);
  }
  return { predicates, params };
}

function decodeCaseJsonb(row: any): any {
  return coerceBigintFields({
    ...row,
    events: typeof row.events === "string" ? JSON.parse(row.events) : row.events,
    judgments: typeof row.judgments === "string" ? JSON.parse(row.judgments) : row.judgments,
    failure: typeof row.failure === "string" ? JSON.parse(row.failure) : row.failure,
  });
}

// Re-exports for convenience
export type { EvalCase, CaseStatus };
