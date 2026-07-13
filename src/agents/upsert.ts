/**
 * Upsert an agent row before any session/eval row that references it.
 *
 * Identity: agent_id alone is the primary key. account_id and agent_name
 * are regular columns on the agent — both COALESCE-merge on upsert so a
 * subsequent upload without a value doesn't overwrite an earlier value.
 * A non-null new value overwrites (last-writer-wins for actively
 * supplied data).
 *
 * Every ingest path (multipart session report, eval upload, OTLP session
 * report body, OTLP agent_id/agent_name tag) calls this helper first.
 * The agent row is guaranteed to exist after the call; the caller then
 * INSERTs its session/eval row, protected by FK on sessions.agent_id /
 * eval_runs.agent_id → agents.agent_id.
 */

import { sql } from "../db.js";

export interface AgentUpsertPatch {
  /** Required. Opaque caller-supplied id; any string is accepted. */
  agentId: string;
  /** Last-known account for this agent. COALESCE-merged. */
  accountId?: string | null;
  /** Human-readable label. COALESCE-merged — absence does NOT clear an
   *  earlier non-null value. */
  agentName?: string | null;
}

function normalize(patch: AgentUpsertPatch): {
  agentId: string;
  accountId: string | null;
  agentName: string | null;
} {
  if (!patch.agentId || typeof patch.agentId !== "string") {
    throw new Error("upsertAgent: agentId is required and must be a string");
  }
  return {
    agentId: patch.agentId,
    accountId:
      typeof patch.accountId === "string" && patch.accountId.length > 0
        ? patch.accountId
        : null,
    agentName:
      typeof patch.agentName === "string" && patch.agentName.length > 0
        ? patch.agentName
        : null,
  };
}

/**
 * Upsert via the module-level `sql` handle. Use this when the agent
 * upsert doesn't need to share a transaction with the next INSERT.
 */
export async function upsertAgent(patch: AgentUpsertPatch): Promise<void> {
  const n = normalize(patch);
  await sql`
    INSERT INTO agents (agent_id, account_id, agent_name)
    VALUES (${n.agentId}, ${n.accountId}, ${n.agentName})
    ON CONFLICT (agent_id) DO UPDATE
      SET agent_name = COALESCE(EXCLUDED.agent_name, agents.agent_name),
          account_id = COALESCE(EXCLUDED.account_id, agents.account_id),
          updated_at = NOW()
  `;
}

/**
 * Same as upsertAgent but on a caller-supplied transaction handle.
 * Use this when the agent upsert MUST be atomic with the session/eval
 * insert that follows (so a failure rolls back both).
 */
export async function upsertAgentTx(
  tx: any,
  patch: AgentUpsertPatch,
): Promise<void> {
  const n = normalize(patch);
  await tx`
    INSERT INTO agents (agent_id, account_id, agent_name)
    VALUES (${n.agentId}, ${n.accountId}, ${n.agentName})
    ON CONFLICT (agent_id) DO UPDATE
      SET agent_name = COALESCE(EXCLUDED.agent_name, agents.agent_name),
          account_id = COALESCE(EXCLUDED.account_id, agents.account_id),
          updated_at = NOW()
  `;
}
