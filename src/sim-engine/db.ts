import { sql } from "../db.js";
import { jsonbParam } from "../jsonb-param.js";

// AO Simulation Engine — data accessors for the ao_sim_* tables.
//
// AO owns three generic tables (migrations 019+020): ao_sim_scenario (the generated
// scenario library), ao_sim_run (one row per run) and ao_sim_run_scenario (one row per
// scenario execution). AO never reads/writes another service's tables — `agent_id` and
// `tenant_id` are opaque caller-supplied strings (NO FK anywhere). On the managed
// deployment the tables are pre-created in the shared core DB and AO is DML-only
// (AUTO_MIGRATE=off): every accessor here is pure DML, and writes are gated by callers
// on `SIM_PERSIST && dbConfigured` — never on migration state (src/db-probe.ts verifies
// table presence at boot instead).
//
// bun:sql gotchas honored throughout (see CLAUDE.md / src/alerts/engine.ts):
//   • jsonb params bind via `jsonbParam(v)` + a `::text::jsonb` cast — NEVER a raw
//     JS value with bare `::jsonb`. bun changes raw-value jsonb serialization across
//     versions (1.2.23 stored a JS ARRAY as an invalid-JSON string scalar — the
//     2026-07-13 dev judging outage); stringifying and letting Postgres parse is
//     version-proof. See src/jsonb-param.ts.
//   • JS arrays do NOT bind to Postgres arrays in bun:sql — they coerce to a
//     comma-joined string ("a,b"), so `::text[]`/`= ANY(${arr})`/`IN ${arr}` all
//     fail with "malformed array literal" (verified). Bind arrays via jsonbParam,
//     membership via `IN (SELECT jsonb_array_elements_text(${jsonbParam(arr)}::text::jsonb)::uuid)`.
//   • Optional filters use `(${x}::type IS NULL OR col = ${x})` rather than
//     composing query fragments — clean and injection-safe.
// bun:sql returns rows with snake_case column names and jsonb already parsed to
// JS values, so the Row types below mirror the columns verbatim.

// ── Row types (the raw DB shape returned by bun:sql) ───────────────────────────

export interface SimScenarioRow {
  id: string;
  tenant_id: string | null;
  agent_id: string | null;
  name: string;
  scenario: Record<string, unknown>;
  tags: string[];
  source: string;
  coverage_key: string | null;
  is_deleted: boolean;
  created_at: Date;
  updated_at: Date;
}

// ── Scenarios (the generated library a run selects from) ────────────────────────
// Reads filter `is_deleted = FALSE`: the orchestrator-service side soft-deletes scenario
// rows (so historical run exports keep scenario names), while AO's own delete API
// hard-DELETEs — both coexist against the same table.

export interface CreateScenarioInput {
  tenantId?: string | null;
  agentId?: string | null;
  name: string;
  scenario: unknown;
  tags?: string[];
  source?: string;
  coverageKey?: string | null;
}

export async function createScenario(input: CreateScenarioInput): Promise<SimScenarioRow> {
  const [row] = await sql`
    INSERT INTO ao_sim_scenario
      (tenant_id, agent_id, name, scenario, tags, source, coverage_key)
    VALUES
      (${input.tenantId ?? null}, ${input.agentId ?? null}, ${input.name},
       ${jsonbParam(input.scenario)}::text::jsonb, ${jsonbParam(input.tags ?? [])}::text::jsonb, ${input.source ?? "generated"},
       ${input.coverageKey ?? null})
    RETURNING *
  `;
  return row as SimScenarioRow;
}

export async function getScenario(id: string): Promise<SimScenarioRow | null> {
  const [row] = await sql`
    SELECT * FROM ao_sim_scenario WHERE id = ${id} AND is_deleted = FALSE
  `;
  return (row as SimScenarioRow) ?? null;
}

/** Fetch scenarios by id (what a run request's `scenario_uuids` resolves to). */
export async function getScenariosByIds(ids: string[]): Promise<SimScenarioRow[]> {
  if (ids.length === 0) return [];
  const rows = await sql`
    SELECT * FROM ao_sim_scenario
    WHERE id IN (SELECT jsonb_array_elements_text(${jsonbParam(ids)}::text::jsonb)::uuid)
      AND is_deleted = FALSE
  `;
  return rows as SimScenarioRow[];
}

export interface ListScenariosInput {
  tenantId?: string | null;
  agentId?: string | null;
  limit: number;
  offset: number;
}

export async function listScenarios(
  input: ListScenariosInput,
): Promise<{ objects: SimScenarioRow[]; total: number }> {
  const tenantId = input.tenantId ?? null;
  const agentId = input.agentId ?? null;
  const objects = await sql`
    SELECT * FROM ao_sim_scenario
    WHERE (${tenantId}::text IS NULL OR tenant_id = ${tenantId})
      AND (${agentId}::text IS NULL OR agent_id = ${agentId})
      AND is_deleted = FALSE
    ORDER BY created_at DESC
    LIMIT ${input.limit} OFFSET ${input.offset}
  `;
  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM ao_sim_scenario
    WHERE (${tenantId}::text IS NULL OR tenant_id = ${tenantId})
      AND (${agentId}::text IS NULL OR agent_id = ${agentId})
      AND is_deleted = FALSE
  `;
  return { objects: objects as SimScenarioRow[], total: count as number };
}

/** Bulk-delete scenarios by id. Returns the number actually deleted. */
export async function deleteScenarios(ids: string[], tenantId?: string | null): Promise<number> {
  if (ids.length === 0) return 0;
  // Scope to the caller's tenant so one tenant cannot delete another's scenarios
  // by guessing/leaking a uuid (IDOR). null tenantId = unscoped (single-tenant /
  // no auth-id) — mirrors listScenarios / deleteScenariosByAgent.
  const tenant = tenantId ?? null;
  const rows = await sql`
    DELETE FROM ao_sim_scenario
    WHERE id IN (SELECT jsonb_array_elements_text(${jsonbParam(ids)}::text::jsonb)::uuid)
      AND (${tenant}::text IS NULL OR tenant_id = ${tenant})
    RETURNING id
  `;
  return rows.length;
}

/** Delete every scenario for an agent (DELETE /scenarios?phlo_uuid), scoped to the tenant
 *  when provided. Returns the number deleted. */
export async function deleteScenariosByAgent(agentId: string, tenantId?: string | null): Promise<number> {
  const tenant = tenantId ?? null;
  const rows = await sql`
    DELETE FROM ao_sim_scenario
    WHERE agent_id = ${agentId}
      AND (${tenant}::text IS NULL OR tenant_id = ${tenant})
    RETURNING id
  `;
  return rows.length;
}

// ── Runs (ao_sim_run + ao_sim_run_scenario — the run-result write path) ─────────
// Written by the SQS consumer + orchestrator NEXT TO the existing Redis emits (the
// stream stays the live/SSE source of truth; these rows are the durable history).
// The orchestrator service reads them back with `WHERE agent_id = <its flow uuid>` —
// no join, no mapping (aodb-write.md §2).

export interface UpsertRunInput {
  /** The client-supplied run uuid (SQS `simulation_run_uuid`) — the PK. */
  id: string;
  tenantId: string;
  agentId: string;
  name?: string | null;
  scenarioCount?: number | null;
  maxTurns?: number | null;
}

/** Idempotent run-header create: every scenario message of a run calls this; the first
 *  one inserts, the rest no-op (ON CONFLICT DO NOTHING — mirrors the Redis-side "any
 *  worker may be first" posture). */
export async function upsertRun(input: UpsertRunInput): Promise<void> {
  await sql`
    INSERT INTO ao_sim_run (id, tenant_id, agent_id, name, scenario_count, max_turns)
    VALUES (${input.id}, ${input.tenantId}, ${input.agentId}, ${input.name ?? null},
            ${input.scenarioCount ?? 0}, ${input.maxTurns ?? 25})
    ON CONFLICT (id) DO NOTHING
  `;
}

export interface InsertRunScenarioInput {
  /** AO-minted per-execution uuid (emitted on scenario_started as flow_run_uuid). */
  id: string;
  simRunId: string;
  scenarioRef?: string | null;
  scenarioIndex?: number | null;
}

/** Create the per-scenario row at scenario_started (status 'running'). */
export async function insertRunScenario(input: InsertRunScenarioInput): Promise<void> {
  await sql`
    INSERT INTO ao_sim_run_scenario (id, sim_run_id, scenario_ref, scenario_index)
    VALUES (${input.id}, ${input.simRunId}, ${input.scenarioRef ?? null}, ${input.scenarioIndex ?? null})
    ON CONFLICT (id) DO NOTHING
  `;
}

/**
 * Tri-state pass/fail outcome. Precedence (MUST be mirrored in the orchestrator service's
 * `_extract_goal_passed` — the two write the same run counters, and drift here silently skews
 * every dashboard pass rate):
 *   1. error / eval_error → null (NEITHER counter moves — passed+failed ≤ completed is normal),
 *   2. stop_reason === "route_mismatch" → false (the run took the wrong route; error is null so
 *      the row still counts as failed),
 *   3. evaluation.criteria_evaluation present → its `passed` (criteria are authoritative over
 *      flow goals; `caller_goal_met`'s target_achieved is NOT — it only ended the call),
 *   4. otherwise the flow-goal fallback: passed = ANY goal `achieved` (not all),
 *   5. nothing to judge (no evaluation / no criteria / empty goal list) → null.
 * Exported for unit tests.
 */
export function extractGoalPassed(args: {
  error?: string | null;
  evalError?: boolean;
  evaluation?: unknown;
  stopReason?: string | null;
}): boolean | null {
  if (args.error || args.evalError) return null;
  if (args.stopReason === "route_mismatch") return false;
  const evaluation = args.evaluation;
  if (evaluation === null || typeof evaluation !== "object") return null;
  const criteriaEval = (evaluation as Record<string, unknown>).criteria_evaluation;
  if (criteriaEval !== null && typeof criteriaEval === "object" && typeof (criteriaEval as Record<string, unknown>).passed === "boolean") {
    return (criteriaEval as Record<string, unknown>).passed as boolean;
  }
  const goalEval = (evaluation as Record<string, unknown>).goal_evaluation;
  if (goalEval === null || typeof goalEval !== "object") return null;
  const goals = (goalEval as Record<string, unknown>).goals;
  if (!Array.isArray(goals) || goals.length === 0) return null;
  return goals.some(
    (g) => g !== null && typeof g === "object" && Boolean((g as Record<string, unknown>).achieved),
  );
}

export interface CompleteRunScenarioInput {
  id: string;
  simRunId: string;
  scenarioRef?: string | null;
  scenarioIndex?: number | null;
  status: "completed" | "error";
  stopReason?: string | null;
  turnCount?: number | null;
  evaluation?: unknown;
  evalError?: boolean;
  error?: string | null;
  /** The turn_completed payloads exactly as emitted to the :RESULTS stream. */
  transcript?: unknown[];
}

/**
 * Terminal write for one scenario execution: update the row scenario_started inserted
 * (or INSERT it if the insert never landed — ordering-safe upsert), then bump the run
 * counters atomically: completed_count always; scenarios_passed/failed per the tri-state
 * goal outcome (see extractGoalPassed).
 */
export async function completeRunScenario(input: CompleteRunScenarioInput): Promise<void> {
  const evaluation = input.evaluation ?? null;
  const transcript = input.transcript ?? [];
  const updated = await sql`
    UPDATE ao_sim_run_scenario SET
      status = ${input.status},
      stop_reason = ${input.stopReason ?? null},
      turn_count = ${input.turnCount ?? null},
      evaluation = ${jsonbParam(evaluation)}::text::jsonb,
      eval_error = ${input.evalError ?? false},
      error = ${input.error ?? null},
      transcript = ${jsonbParam(transcript)}::text::jsonb,
      updated_at = NOW()
    WHERE id = ${input.id}
    RETURNING id
  `;
  if (updated.length === 0) {
    await sql`
      INSERT INTO ao_sim_run_scenario
        (id, sim_run_id, scenario_ref, scenario_index, status, stop_reason, turn_count,
         evaluation, eval_error, error, transcript)
      VALUES
        (${input.id}, ${input.simRunId}, ${input.scenarioRef ?? null}, ${input.scenarioIndex ?? null},
         ${input.status}, ${input.stopReason ?? null}, ${input.turnCount ?? null},
         ${jsonbParam(evaluation)}::text::jsonb, ${input.evalError ?? false}, ${input.error ?? null}, ${jsonbParam(transcript)}::text::jsonb)
      ON CONFLICT (id) DO NOTHING
    `;
  }

  const goalPassed = extractGoalPassed({
    error: input.error,
    evalError: input.evalError,
    evaluation: input.evaluation,
    stopReason: input.stopReason,
  });
  const passedInc = goalPassed === true ? 1 : 0;
  const failedInc = goalPassed === false ? 1 : 0;
  await sql`
    UPDATE ao_sim_run SET
      completed_count = completed_count + 1,
      scenarios_passed = scenarios_passed + ${passedInc},
      scenarios_failed = scenarios_failed + ${failedInc},
      updated_at = NOW()
    WHERE id = ${input.simRunId}
  `;
}

/** Terminal run status at the completion gate (the Lua SETNX makes the caller exactly-once).
 *  Only flips a still-running run so a failed/cancelled status is never overwritten. */
export async function finalizeRun(id: string): Promise<void> {
  await sql`
    UPDATE ao_sim_run SET status = 'completed', completed_at = NOW(), updated_at = NOW()
    WHERE id = ${id} AND status = 'running'
  `;
}

export async function failRun(id: string, errorMessage: string): Promise<void> {
  await sql`
    UPDATE ao_sim_run SET status = 'failed', error_message = ${errorMessage},
      completed_at = NOW(), updated_at = NOW()
    WHERE id = ${id} AND status = 'running'
  `;
}

/** No production caller yet — reserved for the run-cancellation API (aodb-write.md); kept
 *  because it completes the status-transition set and is exercised by the integration suite. */
export async function cancelRun(id: string): Promise<void> {
  await sql`
    UPDATE ao_sim_run SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
    WHERE id = ${id} AND status = 'running'
  `;
}
