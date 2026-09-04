// Judge-registry CRUD. Custom rows only are writable — the default rows are
// the product's shipped judges and every account is scored against the same
// set, so mutating one would silently change what a judge_name means across
// accounts. The immutability rule is enforced here (WHERE type='custom'), not
// just in the route layer.
import { sql } from "../db.js";
import { jsonbParam } from "../jsonb-param.js";
import { CUSTOM_METRIC_OUT } from "../evals-engine/judges/custom-metric.js";

export interface JudgeRecord {
  id: string;
  name: string;
  /** '' = unscoped (defaults, and single-tenant installs). */
  account_id: string;
  display_name: string;
  description: string;
  type: "default" | "custom";
  scope: "node" | "conversation";
  kind: "llm" | "code";
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

const COLS = sql`id, name, account_id, display_name, description, type, scope, kind, enabled, created_at, updated_at`;

export async function listJudges(opts: {
  type: "default" | "custom" | null;
  /** Tenant filter: defaults (account_id='') plus THIS account's customs.
   *  null = unscoped caller (single-tenant/OSS) — sees everything. */
  accountId: string | null;
  limit: number;
  offset: number;
}): Promise<{ judges: JudgeRecord[]; totalCount: number }> {
  const typeFilter = opts.type ? sql`AND type = ${opts.type}` : sql``;
  const accountFilter =
    opts.accountId !== null ? sql`AND account_id IN ('', ${opts.accountId})` : sql``;
  const rows = await sql`
    SELECT ${COLS} FROM ao_judges WHERE TRUE ${typeFilter} ${accountFilter}
    ORDER BY type, display_name
    LIMIT ${opts.limit} OFFSET ${opts.offset}
  `;
  const count = await sql`SELECT COUNT(*)::int AS n FROM ao_judges WHERE TRUE ${typeFilter} ${accountFilter}`;
  return { judges: rows as unknown as JudgeRecord[], totalCount: count[0].n };
}

export async function getJudge(id: string): Promise<JudgeRecord | null> {
  const rows = await sql`SELECT ${COLS} FROM ao_judges WHERE id = ${id}`;
  return (rows[0] as unknown as JudgeRecord) ?? null;
}

export class JudgeNameConflictError extends Error {}

export async function createCustomJudge(input: {
  name: string;
  accountId: string;
  display_name: string;
  description: string;
  scope: "node" | "conversation";
  enabled: boolean;
}): Promise<JudgeRecord> {
  // The description IS the judge's criteria: stored as the prompt body with
  // the fixed custom-metric output section, mirroring the default rows' shape.
  const prompt = { body: input.description, output: CUSTOM_METRIC_OUT, slots: [] };
  try {
    const rows = await sql`
      INSERT INTO ao_judges (name, account_id, display_name, description, type, scope, kind, prompt, config, enabled)
      VALUES (${input.name}, ${input.accountId ?? ""}, ${input.display_name}, ${input.description}, 'custom', ${input.scope},
              'llm', ${jsonbParam(prompt)}::text::jsonb, '{}'::jsonb, ${input.enabled})
      RETURNING ${COLS}
    `;
    return rows[0] as unknown as JudgeRecord;
  } catch (e) {
    if ((e as { errno?: string }).errno === "23505") throw new JudgeNameConflictError(input.name);
    throw e;
  }
}

export async function updateCustomJudge(
  id: string,
  patch: { display_name?: string; description?: string; scope?: "node" | "conversation"; enabled?: boolean },
  /** Scoped caller: may only update its own rows. null = unscoped. */
  accountId: string | null = null,
): Promise<JudgeRecord | null> {
  // description drives the prompt body, so the two update together; the name
  // (fan-out key) deliberately does NOT follow display_name renames — verdicts
  // already written under it would silently detach.
  const rows = await sql`
    UPDATE ao_judges SET
      display_name = COALESCE(${patch.display_name ?? null}, display_name),
      description = COALESCE(${patch.description ?? null}, description),
      scope = COALESCE(${patch.scope ?? null}, scope),
      enabled = COALESCE(${patch.enabled ?? null}, enabled),
      prompt = CASE WHEN ${patch.description ?? null}::text IS NULL THEN prompt
                    ELSE jsonb_set(prompt, '{body}', to_jsonb(${patch.description ?? null}::text)) END,
      updated_at = NOW()
    WHERE id = ${id} AND type = 'custom'
      ${accountId !== null ? sql`AND account_id = ${accountId}` : sql``}
    RETURNING ${COLS}
  `;
  return (rows[0] as unknown as JudgeRecord) ?? null;
}

export async function deleteCustomJudge(id: string, accountId: string | null = null): Promise<boolean> {
  const rows = await sql`
    DELETE FROM ao_judges WHERE id = ${id} AND type = 'custom'
      ${accountId !== null ? sql`AND account_id = ${accountId}` : sql``}
    RETURNING id`;
  return rows.length > 0;
}

// ── agent ↔ judge mapping ────────────────────────────────────────────────────

export interface AgentJudgeRecord extends JudgeRecord {
  /** Mapping-level switch (a judge can stay mapped but paused for one agent). */
  mapping_enabled: boolean;
}

export async function listAgentJudges(agentId: string): Promise<AgentJudgeRecord[]> {
  const rows = await sql`
    SELECT j.id, j.name, j.display_name, j.description, j.type, j.scope, j.kind, j.enabled,
           j.created_at, j.updated_at, aj.enabled AS mapping_enabled
    FROM ao_agent_judges aj
    JOIN ao_judges j ON j.id = aj.judge_id
    WHERE aj.agent_id = ${agentId}
    ORDER BY j.display_name
  `;
  return rows as unknown as AgentJudgeRecord[];
}

export class UnknownJudgeIdsError extends Error {
  constructor(public readonly ids: string[]) {
    super(`unknown or non-custom judge ids: ${ids.join(", ")}`);
  }
}

/** Replace the agent's custom-judge set wholesale (PUT semantics — the builder
 *  sends the full desired list). Only custom judges are mappable: defaults run
 *  for every agent already, a mapping row for one would double-judge. */
export async function setAgentJudges(
  agentId: string,
  entries: Array<{ judge_id: string; enabled: boolean }>,
): Promise<AgentJudgeRecord[]> {
  const ids = entries.map((e) => e.judge_id);
  // bun:sql binds a JS array as a comma-joined STRING, not a Postgres array —
  // hand-build the {…} literal from ids the caller has already UUID-validated,
  // re-checked here so the literal can never be corrupted.
  for (const id of ids) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new UnknownJudgeIdsError([id]);
  }
  const idsLiteral = `{${ids.join(",")}}`;
  await sql.begin(async (tx: any) => {
    if (ids.length > 0) {
      const found = await tx`SELECT id FROM ao_judges WHERE id = ANY(${idsLiteral}::uuid[]) AND type = 'custom'`;
      const ok = new Set(found.map((r: any) => r.id));
      const missing = ids.filter((id) => !ok.has(id));
      if (missing.length > 0) throw new UnknownJudgeIdsError(missing);
    }
    await tx`DELETE FROM ao_agent_judges WHERE agent_id = ${agentId}`;
    for (const e of entries) {
      await tx`
        INSERT INTO ao_agent_judges (agent_id, judge_id, enabled)
        VALUES (${agentId}, ${e.judge_id}, ${e.enabled})
        ON CONFLICT (agent_id, judge_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
      `;
    }
  });
  return listAgentJudges(agentId);
}
