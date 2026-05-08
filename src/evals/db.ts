import { sql } from "../db.js";
import type {
  EvalCase,
  EvalPayloadV0,
  CaseStatus,
} from "./schema.js";
import { computeCaseMetrics, ensurePricesLoaded } from "./summarize.js";
export { summarize } from "./summarize.js";
export type { RunSummary } from "./summarize.js";

// Source of truth for run status values — mirrors the status enum in schema.ts.
const RUN_STATUS = {
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  queued: "queued",
} as const;

// ── Insert ──────────────────────────────────────────────────────────────────

export async function insertEvalRun(payload: EvalPayloadV0): Promise<void> {
  const { run, cases } = payload;

  const startedAt = new Date(run.started_at * 1000);
  const finishedAt = run.finished_at != null ? new Date(run.finished_at * 1000) : null;
  const durationMs = run.finished_at != null
    ? Math.max(0, Math.round((run.finished_at - run.started_at) * 1000))
    : null;
  const runStatus = run.status
    ?? (run.finished_at != null ? "completed" : "running");
  const lastHeartbeatAt = new Date();

  await ensurePricesLoaded();
  const caseMetrics = cases.map((c) => computeCaseMetrics(c.events ?? []));

  await sql.begin(async (tx: any) => {
    await tx`
      INSERT INTO eval_runs (
        run_id, name, account_id, agent_id,
        framework, framework_version,
        testing_framework, testing_framework_version,
        started_at, finished_at, duration_ms, status, last_heartbeat_at,
        total, passed, failed, errored, skipped,
        ci, raw_payload,
        ttft_p50_ms, ttft_p95_ms, ttft_avg_ms,
        ttfb_p50_ms, ttfb_p95_ms, ttfb_avg_ms,
        prompt_tokens, cached_prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd
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
        ${runStatus},
        ${lastHeartbeatAt},
        0, 0, 0, 0, 0,
        ${run.ci != null ? JSON.stringify(run.ci) : null}::jsonb,
        ${JSON.stringify(payload)}::jsonb,
        NULL, NULL, NULL,
        NULL, NULL, NULL,
        0, 0, 0, 0, NULL
      )
      ON CONFLICT (run_id) DO UPDATE SET
        started_at        = LEAST(eval_runs.started_at, EXCLUDED.started_at),
        finished_at       = CASE
          WHEN eval_runs.finished_at IS NULL THEN EXCLUDED.finished_at
          WHEN EXCLUDED.finished_at IS NULL THEN eval_runs.finished_at
          ELSE GREATEST(eval_runs.finished_at, EXCLUDED.finished_at)
        END,
        duration_ms       = CASE
          WHEN eval_runs.duration_ms IS NULL THEN EXCLUDED.duration_ms
          WHEN EXCLUDED.duration_ms IS NULL THEN eval_runs.duration_ms
          ELSE GREATEST(eval_runs.duration_ms, EXCLUDED.duration_ms)
        END,
        -- Status literals below must match RUN_STATUS const (source of truth: schema.ts enum).
        status            = CASE
          WHEN eval_runs.status IN ('completed', 'failed', 'cancelled')
            AND EXCLUDED.status IN ('queued', 'running')
            THEN eval_runs.status
          ELSE EXCLUDED.status
        END,
        last_heartbeat_at = EXCLUDED.last_heartbeat_at,
        -- first writer wins for identity/metadata fields
        name                       = COALESCE(eval_runs.name, EXCLUDED.name),
        account_id                 = COALESCE(eval_runs.account_id, EXCLUDED.account_id),
        agent_id                   = COALESCE(eval_runs.agent_id, EXCLUDED.agent_id),
        framework                  = COALESCE(eval_runs.framework, EXCLUDED.framework),
        framework_version          = COALESCE(eval_runs.framework_version, EXCLUDED.framework_version),
        testing_framework          = COALESCE(eval_runs.testing_framework, EXCLUDED.testing_framework),
        testing_framework_version  = COALESCE(eval_runs.testing_framework_version, EXCLUDED.testing_framework_version),
        ci                         = COALESCE(eval_runs.ci, EXCLUDED.ci),
        raw_payload                = COALESCE(eval_runs.raw_payload, EXCLUDED.raw_payload)
        -- counters/metrics are no longer maintained here; computed on read from eval_cases
    `;

    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const m = caseMetrics[i];
      const caseDurationMs = c.duration_ms
        ?? (c.started_at != null && c.finished_at != null
          ? Math.max(0, Math.round((c.finished_at - c.started_at) * 1000))
          : null);

      await tx`
        INSERT INTO eval_cases (
          case_id, run_id, name, file, status, duration_ms,
          user_input, events, judgments, failure,
          ttft_p50_ms, ttft_p95_ms, ttft_avg_ms,
          ttfb_p50_ms, ttfb_p95_ms, ttfb_avg_ms,
          turn_count, tool_call_count, interruption_count,
          agent_handoff_count, ttft_sample_count,
          prompt_tokens, cached_prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd
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
          ${m.ttft_p50_ms},
          ${m.ttft_p95_ms},
          ${m.ttft_avg_ms},
          ${m.ttfb_p50_ms},
          ${m.ttfb_p95_ms},
          ${m.ttfb_avg_ms},
          ${m.turn_count},
          ${m.tool_call_count},
          ${m.interruption_count},
          ${m.agent_handoff_count},
          ${m.ttft_sample_count},
          ${m.prompt_tokens},
          ${m.cached_prompt_tokens},
          ${m.completion_tokens},
          ${m.total_tokens},
          ${m.estimated_cost_usd}
        )
        ON CONFLICT (case_id) DO UPDATE SET
          name                 = EXCLUDED.name,
          file                 = EXCLUDED.file,
          status               = EXCLUDED.status,
          duration_ms          = EXCLUDED.duration_ms,
          user_input           = EXCLUDED.user_input,
          events               = EXCLUDED.events,
          judgments            = EXCLUDED.judgments,
          failure              = EXCLUDED.failure,
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
          cached_prompt_tokens = EXCLUDED.cached_prompt_tokens,
          completion_tokens    = EXCLUDED.completion_tokens,
          total_tokens         = EXCLUDED.total_tokens,
          estimated_cost_usd   = EXCLUDED.estimated_cost_usd
      `;
    }
  });
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

export async function deleteEvalCases(runId: string, caseIds: string[]): Promise<number> {
  if (caseIds.length === 0) return 0;
  const placeholders = caseIds.map((_, i) => `$${i + 2}`).join(", ");
  const rows = await sql.unsafe(
    `DELETE FROM eval_cases
     WHERE run_id = $1 AND case_id IN (${placeholders})
     RETURNING case_id`,
    [runId, ...caseIds],
  );
  return rows.length;
}

// ── Stale-run sweeper ────────────────────────────────────────────────────────

export async function sweepStaleRuns(): Promise<number> {
  const rows = await sql.unsafe(
    `UPDATE eval_runs
     SET status = $1, finished_at = COALESCE(finished_at, now())
     WHERE status = $2 AND last_heartbeat_at < now() - interval '60 seconds'
     RETURNING run_id`,
    [RUN_STATUS.failed, RUN_STATUS.running],
  );
  return rows.length;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// Re-exports for convenience
export type { EvalCase, CaseStatus };
