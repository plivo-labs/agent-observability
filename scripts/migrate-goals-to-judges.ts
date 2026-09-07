// One-time migration: conversation goals → custom judges.
//
// Reads the legacy flow_goal rows (shared core DB: flow_goal → phlo →
// organization) and creates one custom judge per distinct
// (account, name, instructions), mapped to every flow (= AO agent_id) that
// declared it — so the coverage that goal judging provided continues as
// custom-metric judging with no gap. Goals with the same name but different
// instructions within one account become separate judges (name suffixed _2…).
//
// Idempotent: a judge whose (account, name) already exists with the SAME
// instructions is reused (mapping upserted); existing mappings are preserved
// via read-modify-write of the full set. Run with --dry-run first.
//
//   DATABASE_URL=... bun scripts/migrate-goals-to-judges.ts [--dry-run]
import { sql } from "../src/db.js";
import { createCustomJudge, listAgentJudges, setAgentJudges, JudgeNameConflictError } from "../src/judges/db.js";
import { customJudgeName } from "../src/evals-engine/judges/custom-metric.js";

const dryRun = process.argv.includes("--dry-run");

const rows = await sql`
  SELECT o.auth_id AS account_id, p.uuid AS agent_id, p.name AS flow_name,
         g.goal_name, COALESCE(NULLIF(TRIM(g.goal_instructions), ''), g.goal_name) AS instructions
  FROM flow_goal g
  JOIN phlo p ON p.id = g.flow_id AND p.is_deleted = FALSE
  JOIN organization o ON o.id = p.organization AND o.is_deleted = FALSE
  WHERE g.is_deleted = FALSE
    AND o.auth_id IS NOT NULL AND o.auth_id <> ''
    AND p.uuid IS NOT NULL
  ORDER BY o.auth_id, g.goal_name
`;
console.log(`${rows.length} live goal declarations found`);

// group: (account, name, instructions) → agents
type Group = { accountId: string; goalName: string; instructions: string; agents: Set<string> };
const groups = new Map<string, Group>();
for (const r of rows as any[]) {
  const key = `${r.account_id}\0${r.goal_name.trim().toLowerCase()}\0${r.instructions.trim()}`;
  const g = groups.get(key) ?? {
    accountId: r.account_id,
    goalName: r.goal_name.trim(),
    instructions: r.instructions.trim(),
    agents: new Set<string>(),
  };
  g.agents.add(r.agent_id);
  groups.set(key, g);
}
console.log(`${groups.size} distinct (account, goal, instructions) groups`);

let created = 0;
let reused = 0;
let mapped = 0;
let suffixed = 0;
for (const g of groups.values()) {
  // same-name-different-instructions within one account → suffix _2, _3…
  const base = customJudgeName(g.goalName);
  let judgeId: string | null = null;
  for (let n = 1; n < 10 && judgeId === null; n++) {
    const candidate = n === 1 ? base : `${base}_${n}`;
    const existing = await sql`
      SELECT id, description FROM ao_judges
      WHERE account_id = ${g.accountId} AND name = ${candidate} AND type = 'custom'
    `;
    if (existing.length > 0) {
      if ((existing[0] as any).description.trim() === g.instructions) {
        judgeId = (existing[0] as any).id;
        reused++;
      }
      continue; // same name, different instructions → try the next suffix
    }
    if (dryRun) {
      console.log(`[dry-run] would create ${candidate} (${g.accountId}) ← "${g.goalName}" for ${g.agents.size} agent(s)`);
      judgeId = "dry-run";
      created++;
      if (n > 1) suffixed++;
      break;
    }
    try {
      const judge = await createCustomJudge({
        accountId: g.accountId,
        name: candidate,
        display_name: g.goalName,
        description: g.instructions,
        scope: "conversation",
        enabled: true, // goals were live judging — no coverage cliff
      });
      judgeId = judge.id;
      created++;
      if (n > 1) suffixed++;
    } catch (e) {
      if (e instanceof JudgeNameConflictError) continue; // race — retry next suffix
      throw e;
    }
  }
  if (judgeId === null) {
    console.error(`SKIPPED (name space exhausted): ${base} (${g.accountId})`);
    continue;
  }
  if (dryRun) continue;
  for (const agentId of g.agents) {
    const current = await listAgentJudges(agentId);
    if (current.some((m) => m.id === judgeId)) continue;
    await setAgentJudges(agentId, [
      ...current.map((m) => ({ judge_id: m.id, enabled: m.mapping_enabled })),
      { judge_id: judgeId, enabled: true },
    ]);
    mapped++;
  }
}
console.log(
  `done: created=${created} (suffixed=${suffixed}) reused=${reused} mappings added=${mapped}${dryRun ? " [dry-run]" : ""}`,
);
await sql.end();
