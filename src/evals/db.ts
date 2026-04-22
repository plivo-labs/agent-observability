import { sql } from "../db.js";
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

  await sql.begin(async (tx: any) => {
    await tx`
      INSERT INTO eval_runs (
        run_id, account_id, agent_id, framework, framework_version,
        sdk, sdk_version, started_at, finished_at, duration_ms,
        total, passed, failed, errored, skipped,
        ci, raw_payload
      ) VALUES (
        ${run.run_id},
        ${run.account_id ?? null},
        ${run.agent_id ?? null},
        ${run.framework},
        ${run.framework_version ?? null},
        ${run.sdk ?? null},
        ${run.sdk_version ?? null},
        ${startedAt},
        ${finishedAt},
        ${durationMs},
        ${summary.total},
        ${summary.passed},
        ${summary.failed},
        ${summary.errored},
        ${summary.skipped},
        ${run.ci != null ? JSON.stringify(run.ci) : null}::jsonb,
        ${JSON.stringify(payload)}::jsonb
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
          user_input, events, judgments, failure
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
          ${c.failure != null ? JSON.stringify(c.failure) : null}::jsonb
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
  /** Multi-value — `framework IN (...)` when non-empty. */
  frameworks?: string[] | null;
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

export async function listEvalRuns(opts: ListEvalRunsOpts): Promise<any[]> {
  const { predicates, params } = buildPredicates(opts);
  const whereClause = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const rows = await sql.unsafe(
    `SELECT run_id, account_id, agent_id, framework, framework_version, sdk, sdk_version,
            started_at, finished_at, duration_ms,
            total, passed, failed, errored, skipped, ci, created_at
     FROM eval_runs
     ${whereClause}
     ORDER BY started_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, opts.limit, opts.offset],
  );
  return rows;
}

export async function getEvalRun(runId: string): Promise<any | null> {
  const rows = await sql`
    SELECT run_id, account_id, agent_id, framework, framework_version, sdk, sdk_version,
           started_at, finished_at, duration_ms,
           total, passed, failed, errored, skipped, ci, created_at
    FROM eval_runs
    WHERE run_id = ${runId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listEvalCases(runId: string): Promise<any[]> {
  const rows = await sql`
    SELECT case_id, run_id, name, file, status, duration_ms, user_input,
           events, judgments, failure, created_at
    FROM eval_cases
    WHERE run_id = ${runId}
    ORDER BY created_at ASC
  `;
  return rows.map(decodeCaseJsonb);
}

export async function getEvalCase(runId: string, caseId: string): Promise<any | null> {
  const rows = await sql`
    SELECT case_id, run_id, name, file, status, duration_ms, user_input,
           events, judgments, failure, created_at
    FROM eval_cases
    WHERE run_id = ${runId} AND case_id = ${caseId}
    LIMIT 1
  `;
  return rows[0] ? decodeCaseJsonb(rows[0]) : null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildPredicates(opts: ListEvalRunsOpts): { predicates: string[]; params: unknown[] } {
  const predicates: string[] = [];
  const params: unknown[] = [];
  if (opts.accountId) {
    predicates.push(`account_id = $${params.length + 1}`);
    params.push(opts.accountId);
  }
  if (opts.agentId) {
    predicates.push(`agent_id = $${params.length + 1}`);
    params.push(opts.agentId);
  }
  if (opts.frameworks && opts.frameworks.length > 0) {
    const placeholders = opts.frameworks.map(
      (_, i) => `$${params.length + i + 1}`,
    );
    predicates.push(`framework IN (${placeholders.join(", ")})`);
    params.push(...opts.frameworks);
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
  };
}

// Re-exports for convenience
export type { EvalCase, CaseStatus };
