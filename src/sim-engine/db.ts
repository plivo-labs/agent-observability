import { sql } from "../db.js";

// AO Simulation Engine — data accessors for the ao_simulation_scenarios table.
//
// AO owns the generated scenario *library* (AO never reads/writes a CX
// table, never `phlo`). This table is the only one these accessors touch; the
// scenario-library API routes (src/sim-engine/routes.ts) go through here. (Run
// history lives in the orchestrator service in the managed deployment; AO's old in-process run-row accessors were
// removed for V1 along with the in-process dispatch mode.)
//
// bun:sql gotchas honored throughout (see CLAUDE.md / src/alerts/engine.ts):
//   • jsonb params are passed as RAW JS objects/arrays with a `::jsonb` cast —
//     NEVER JSON.stringify first (that lands as a jsonb *string scalar*).
//   • JS arrays do NOT bind to Postgres arrays in bun:sql — they coerce to a
//     comma-joined string ("a,b"), so `::text[]`/`= ANY(${arr})`/`IN ${arr}` all
//     fail with "malformed array literal" (verified). Bind arrays as `::jsonb`,
//     and do membership via `IN (SELECT jsonb_array_elements_text(${arr}::jsonb)::uuid)`.
//   • Optional filters use `(${x}::type IS NULL OR col = ${x})` rather than
//     composing query fragments — clean and injection-safe.
// bun:sql returns rows with snake_case column names and jsonb already parsed to
// JS values, so the Row types below mirror the columns verbatim.

// ── Row types (the raw DB shape returned by bun:sql) ───────────────────────────

export interface SimScenarioRow {
  id: string;
  account_id: string | null;
  agent_id: string | null;
  name: string;
  scenario: Record<string, unknown>;
  tags: string[];
  source: string;
  coverage_key: string | null;
  created_at: Date;
  updated_at: Date;
}

// ── Scenarios (the generated library a run selects from) ────────────────────────

export interface CreateScenarioInput {
  accountId?: string | null;
  agentId?: string | null;
  name: string;
  scenario: unknown;
  tags?: string[];
  source?: string;
  coverageKey?: string | null;
}

export async function createScenario(input: CreateScenarioInput): Promise<SimScenarioRow> {
  const [row] = await sql`
    INSERT INTO ao_simulation_scenarios
      (account_id, agent_id, name, scenario, tags, source, coverage_key)
    VALUES
      (${input.accountId ?? null}, ${input.agentId ?? null}, ${input.name},
       ${input.scenario}::jsonb, ${input.tags ?? []}::jsonb, ${input.source ?? "generated"},
       ${input.coverageKey ?? null})
    RETURNING *
  `;
  return row as SimScenarioRow;
}

export async function getScenario(id: string): Promise<SimScenarioRow | null> {
  const [row] = await sql`SELECT * FROM ao_simulation_scenarios WHERE id = ${id}`;
  return (row as SimScenarioRow) ?? null;
}

/** Fetch scenarios by id (what a run request's `scenario_uuids` resolves to). */
export async function getScenariosByIds(ids: string[]): Promise<SimScenarioRow[]> {
  if (ids.length === 0) return [];
  const rows = await sql`
    SELECT * FROM ao_simulation_scenarios
    WHERE id IN (SELECT jsonb_array_elements_text(${ids}::jsonb)::uuid)
  `;
  return rows as SimScenarioRow[];
}

export interface ListScenariosInput {
  accountId?: string | null;
  agentId?: string | null;
  limit: number;
  offset: number;
}

export async function listScenarios(
  input: ListScenariosInput,
): Promise<{ objects: SimScenarioRow[]; total: number }> {
  const accountId = input.accountId ?? null;
  const agentId = input.agentId ?? null;
  const objects = await sql`
    SELECT * FROM ao_simulation_scenarios
    WHERE (${accountId}::text IS NULL OR account_id = ${accountId})
      AND (${agentId}::text IS NULL OR agent_id = ${agentId})
    ORDER BY created_at DESC
    LIMIT ${input.limit} OFFSET ${input.offset}
  `;
  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM ao_simulation_scenarios
    WHERE (${accountId}::text IS NULL OR account_id = ${accountId})
      AND (${agentId}::text IS NULL OR agent_id = ${agentId})
  `;
  return { objects: objects as SimScenarioRow[], total: count as number };
}

/** Bulk-delete scenarios by id. Returns the number actually deleted. */
export async function deleteScenarios(ids: string[], accountId?: string | null): Promise<number> {
  if (ids.length === 0) return 0;
  // Scope to the caller's account so one tenant cannot delete another's scenarios
  // by guessing/leaking a uuid (IDOR). null accountId = unscoped (single-tenant /
  // no auth-id) — mirrors listScenarios / deleteScenariosByAgent.
  const acct = accountId ?? null;
  const rows = await sql`
    DELETE FROM ao_simulation_scenarios
    WHERE id IN (SELECT jsonb_array_elements_text(${ids}::jsonb)::uuid)
      AND (${acct}::text IS NULL OR account_id = ${acct})
    RETURNING id
  `;
  return rows.length;
}

/** Delete every scenario for an agent (DELETE /scenarios?phlo_uuid), scoped to the account
 *  when provided. Returns the number deleted. */
export async function deleteScenariosByAgent(agentId: string, accountId?: string | null): Promise<number> {
  const acct = accountId ?? null;
  const rows = await sql`
    DELETE FROM ao_simulation_scenarios
    WHERE agent_id = ${agentId}
      AND (${acct}::text IS NULL OR account_id = ${acct})
    RETURNING id
  `;
  return rows.length;
}
