import { sql } from "../db.js";
import { escapeLikePattern } from "../response.js";
import type {
  EvalCase,
  EvalPayloadV0,
  CaseStatus,
} from "./schema.js";
import { summarize } from "./summarize.js";
export { summarize } from "./summarize.js";
export type { RunSummary } from "./summarize.js";

// ── Insert ──────────────────────────────────────────────────────────────────

export async function insertEvalRun(payload: EvalPayloadV0): Promise<void> {
  const { run, cases } = payload;
  const summary = summarize(cases);

  const startedAt = new Date(run.started_at * 1000);
  const finishedAt = new Date(run.finished_at * 1000);
  const durationMs = Math.max(0, Math.round((run.finished_at - run.started_at) * 1000));

  // jsonb columns (ci, sim_report, events, judgments, failure) are bound as the
  // raw JS value into `${value}::jsonb` — NOT JSON.stringify'd first. Stringifying
  // double-encodes into a jsonb *string scalar* ("[…]") that breaks raw jsonb
  // operators downstream. Keep every jsonb write in this form. (Readers tolerate
  // legacy string scalars; see decodeCaseJsonb / getEvalRun.)
  await sql.begin(async (tx: any) => {
    await tx`
      INSERT INTO eval_runs (
        run_id, account_id, agent_id,
        framework, framework_version,
        testing_framework, testing_framework_version,
        started_at, finished_at, duration_ms,
        total, passed, failed, errored, skipped,
        ci, sim_report
      ) VALUES (
        ${run.run_id},
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
        ${(run.ci ?? null) as any}::jsonb,
        ${(run.sim_report ?? null) as any}::jsonb
      )
    `;

    for (const c of cases) {
      const caseDurationMs = c.duration_ms
        ?? (c.started_at != null && c.finished_at != null
          ? Math.max(0, Math.round((c.finished_at - c.started_at) * 1000))
          : null);

      await tx`
        INSERT INTO eval_cases (
          case_id, run_id, name, file, status, duration_ms,
          user_input, events, judgments, failure, recording_url
        ) VALUES (
          ${c.case_id},
          ${run.run_id},
          ${c.name},
          ${c.file ?? null},
          ${c.status},
          ${caseDurationMs},
          ${c.user_input ?? null},
          ${(c.events ?? []) as any}::jsonb,
          ${(c.judgments ?? []) as any}::jsonb,
          ${(c.failure ?? null) as any}::jsonb,
          ${c.recording_url ?? null}
        )
      `;
    }
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
    `SELECT count(*)::int AS total FROM eval_runs ${whereClause}`,
    params,
  );
  return row.total;
}

const RUN_SELECT_COLS =
  "run_id, account_id, agent_id, " +
  "framework, framework_version, testing_framework, testing_framework_version, " +
  "started_at, finished_at, duration_ms, " +
  "total, passed, failed, errored, skipped, ci, created_at";

export async function listEvalRuns(opts: ListEvalRunsOpts): Promise<any[]> {
  const { predicates, params } = buildPredicates(opts);
  const whereClause = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const rows = await sql.unsafe(
    `SELECT ${RUN_SELECT_COLS}
     FROM eval_runs
     ${whereClause}
     ORDER BY started_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, opts.limit, opts.offset],
  );
  return rows;
}

export async function getEvalRun(runId: string): Promise<any | null> {
  // Detail view additionally carries the full simulation report blob (sim
  // runs only; null for live-call / pytest / vitest). Parse the jsonb so the
  // route returns a structured object, not a string.
  const rows = await sql.unsafe(
    `SELECT ${RUN_SELECT_COLS}, sim_report
     FROM eval_runs
     WHERE run_id = $1
     LIMIT 1`,
    [runId],
  );
  const row = rows[0];
  if (!row) return null;
  if (typeof row.sim_report === "string") {
    try { row.sim_report = JSON.parse(row.sim_report); } catch { /* leave as-is */ }
  }
  return row;
}

// live-call cost lives on `sim_live_calls.cost` (JSONB), not on `eval_cases`.
// The run was persisted from a live suite, so join back through
// `sim_live_suites.eval_run_id = eval_cases.run_id` and match the call by
// `persona_name = eval_cases.name`. Non-live runs have no match → cost is null.
export async function listEvalCases(runId: string): Promise<any[]> {
  const rows = await sql`
    SELECT ec.case_id, ec.run_id, ec.name, ec.file, ec.status, ec.duration_ms,
           ec.user_input, ec.events, ec.judgments, ec.failure, ec.recording_url,
           ec.created_at, lc.cost
    FROM eval_cases ec
    LEFT JOIN sim_live_suites ls ON ls.eval_run_id = ec.run_id
    LEFT JOIN sim_live_calls lc ON lc.suite_id = ls.id AND lc.persona_name = ec.name
    WHERE ec.run_id = ${runId}
    ORDER BY ec.created_at ASC
  `;
  return rows.map(decodeCaseJsonb);
}

export async function getEvalCase(runId: string, caseId: string): Promise<any | null> {
  const rows = await sql`
    SELECT ec.case_id, ec.run_id, ec.name, ec.file, ec.status, ec.duration_ms,
           ec.user_input, ec.events, ec.judgments, ec.failure, ec.recording_url,
           ec.created_at, lc.cost
    FROM eval_cases ec
    LEFT JOIN sim_live_suites ls ON ls.eval_run_id = ec.run_id
    LEFT JOIN sim_live_calls lc ON lc.suite_id = ls.id AND lc.persona_name = ec.name
    WHERE ec.run_id = ${runId} AND ec.case_id = ${caseId}
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
    predicates.push(`LOWER(account_id) LIKE $${params.length + 1}`);
    params.push(`%${escapeLikePattern(opts.accountId.toLowerCase())}%`);
  }
  if (opts.agentId) {
    predicates.push(`LOWER(agent_id) LIKE $${params.length + 1}`);
    params.push(`%${escapeLikePattern(opts.agentId.toLowerCase())}%`);
  }
  if (opts.frameworks && opts.frameworks.length > 0) {
    const placeholders = opts.frameworks.map(
      (_, i) => `$${params.length + i + 1}`,
    );
    predicates.push(`framework IN (${placeholders.join(", ")})`);
    params.push(...opts.frameworks);
  }
  if (opts.testingFrameworks && opts.testingFrameworks.length > 0) {
    const placeholders = opts.testingFrameworks.map(
      (_, i) => `$${params.length + i + 1}`,
    );
    predicates.push(`testing_framework IN (${placeholders.join(", ")})`);
    params.push(...opts.testingFrameworks);
  }
  if (opts.startedFrom) {
    predicates.push(`started_at >= $${params.length + 1}`);
    params.push(opts.startedFrom);
  }
  if (opts.startedTo) {
    predicates.push(`started_at <= $${params.length + 1}`);
    params.push(opts.startedTo);
  }
  return { predicates, params };
}

function decodeCaseJsonb(row: any): any {
  return {
    ...row,
    events: typeof row.events === "string" ? JSON.parse(row.events) : row.events,
    judgments: typeof row.judgments === "string" ? JSON.parse(row.judgments) : row.judgments,
    failure: typeof row.failure === "string" ? JSON.parse(row.failure) : row.failure,
    // live-call cost (JSONB via the join); null for non-live runs.
    cost: row.cost == null ? null : typeof row.cost === "string" ? JSON.parse(row.cost) : row.cost,
  };
}

// Re-exports for convenience
export type { EvalCase, CaseStatus };
