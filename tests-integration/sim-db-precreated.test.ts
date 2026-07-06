import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { sql } from "../src/db.js";
import { upsertRun, completeRunScenario } from "../src/sim-engine/db.js";
import { probeSimTables } from "../src/db-probe.js";

// The pre-created-tables contract (aodb-write.md §5): on the managed deployment the
// ao_sim_* DDL is applied OUT-OF-BAND (pgAdmin / goose) and AO runs DML-only with
// AUTO_MIGRATE=off. That only works if:
//   1. the migration files are self-contained + idempotent — hand-applying them (even
//      repeatedly, even on a DB where they already ran) must be a clean no-op,
//   2. the boot probe sees the tables,
//   3. the write path is pure DML gated on config — never on _migrations state.
//
//   DATABASE_URL=postgres://... bun test tests-integration/sim-db-precreated.test.ts

const MIGRATIONS = join(import.meta.dir, "../migrations");

describe("pre-created ao_sim_* tables contract", () => {
  test("020 DDL is self-contained + idempotent: raw re-apply (the hand-apply path) is a clean no-op", async () => {
    // 020 is the complete hand-apply artifact: it fresh-creates all three tables when
    // absent (its rename guards no-op on a fresh DB). Simulates the DBA applying it to
    // a DB in ANY state (fresh, already migrated, retried after a partial apply).
    const ddl = readFileSync(join(MIGRATIONS, "020_ao_sim_run_tables.sql"), "utf-8");
    await sql.unsafe(ddl);
    await sql.unsafe(ddl); // hand-applies get retried
  });

  test("boot probe passes against the tables", async () => {
    await probeSimTables(); // throws (fails the test) if any table is missing
  });

  test("writes are pure DML — they succeed with zero _migrations involvement", async () => {
    // The write path must not consult migration bookkeeping: prove a full write cycle
    // works purely against the tables (exactly what the Plivo deployment does, where
    // _migrations has no entry for hand-created tables).
    const runId = crypto.randomUUID();
    const rsId = crypto.randomUUID();
    await upsertRun({ id: runId, tenantId: "precreated-t", agentId: "precreated-a" });
    await completeRunScenario({
      id: rsId, simRunId: runId, scenarioRef: "s1", scenarioIndex: 0,
      status: "completed", stopReason: "end_conversation", turnCount: 1,
      evaluation: { goal_evaluation: { goals: [{ goal_name: "g", achieved: true }] } },
      transcript: [{ turn: 1 }],
    });
    const [run] = await sql`SELECT completed_count, scenarios_passed FROM ao_sim_run WHERE id = ${runId}`;
    expect((run as Record<string, unknown>).completed_count).toBe(1);
    expect((run as Record<string, unknown>).scenarios_passed).toBe(1);

    await sql`DELETE FROM ao_sim_run_scenario WHERE id = ${rsId}`;
    await sql`DELETE FROM ao_sim_run WHERE id = ${runId}`;
  });
});
