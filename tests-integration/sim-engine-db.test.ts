import { describe, test, expect } from "bun:test";
import { sql } from "../src/db.js";
import {
  createScenario,
  getScenario,
  getScenariosByIds,
  listScenarios,
  deleteScenarios,
  upsertRun,
  insertRunScenario,
  completeRunScenario,
  finalizeRun,
  failRun,
  cancelRun,
} from "../src/sim-engine/db.js";

// Integration test for the ao_sim_* accessors. Run with a DATABASE_URL pointed at a
// Postgres that has migrations 019+020 applied:
//   DATABASE_URL=postgres://observability:observability@localhost:5433/ao_sim_it \
//     bun test tests-integration/sim-engine-db.test.ts

const TENANT = "it-tenant";
const AGENT = "it-agent-phlo-uuid";

// NOTE: never close the shared `sql` pool here — the other integration suites in
// this process still need it (see tests-integration/helpers.ts).

describe("ao_sim_scenario accessors", () => {
  test("scenario CRUD: create (with tags) → fetch by id → list → delete", async () => {
    const s = await createScenario({
      tenantId: TENANT,
      agentId: AGENT,
      name: "happy path refund",
      scenario: { id: "s1", goal: "refund", world_state: { "n-check": { outcome: "eligible", data: {} } } },
      tags: ["happy", "refund"],
      coverageKey: "C1|P01",
    });
    expect(s.tags).toEqual(["happy", "refund"]); // text[] round-trips
    expect(s.source).toBe("generated");
    expect(s.tenant_id).toBe(TENANT);

    expect((await getScenario(s.id))?.name).toBe("happy path refund");

    const byIds = await getScenariosByIds([s.id]); // uuid[] binding
    expect(byIds.length).toBe(1);
    expect(byIds[0].coverage_key).toBe("C1|P01");

    const listed = await listScenarios({ agentId: AGENT, limit: 50, offset: 0 });
    expect(listed.objects.some((row) => row.id === s.id)).toBe(true);

    expect(await deleteScenarios([s.id])).toBe(1);
    expect(await getScenario(s.id)).toBeNull();
  });

  test("soft-deleted rows are hidden from every read (orchestrator-service delete path)", async () => {
    const s = await createScenario({
      tenantId: TENANT,
      agentId: AGENT,
      name: "soft-deleted scenario",
      scenario: { id: "s-soft", goal: "hide me" },
    });
    await sql`UPDATE ao_sim_scenario SET is_deleted = TRUE WHERE id = ${s.id}`;

    expect(await getScenario(s.id)).toBeNull();
    expect((await getScenariosByIds([s.id])).length).toBe(0);
    const listed = await listScenarios({ agentId: AGENT, limit: 50, offset: 0 });
    expect(listed.objects.some((row) => row.id === s.id)).toBe(false);

    await sql`DELETE FROM ao_sim_scenario WHERE id = ${s.id}`; // cleanup
  });
});

describe("ao_sim_run / ao_sim_run_scenario accessors", () => {
  // Fully-scored evaluation: one goal achieved among failures → tri-state "passed"
  // (ANY achieved, not all — mirrors the orchestrator service's _extract_goal_passed).
  const EVAL_PASSED = {
    goal_evaluation: {
      goals: [
        { goal_name: "g1", achieved: false, reason: "missed" },
        { goal_name: "g2", achieved: true, reason: "done" },
      ],
    },
  };
  const EVAL_FAILED = { goal_evaluation: { goals: [{ goal_name: "g1", achieved: false, reason: "missed" }] } };

  async function runRow(runId: string): Promise<Record<string, unknown>> {
    const [row] = await sql`SELECT * FROM ao_sim_run WHERE id = ${runId}`;
    return row as Record<string, unknown>;
  }

  test("full run lifecycle: upsert (idempotent) → scenarios → counters (tri-state) → finalize", async () => {
    const runId = crypto.randomUUID();
    await upsertRun({ id: runId, tenantId: TENANT, agentId: AGENT, name: "IT run", scenarioCount: 4, maxTurns: 25 });
    // Second upsert is a no-op (any worker can be "first").
    await upsertRun({ id: runId, tenantId: TENANT, agentId: AGENT, name: "SHOULD NOT OVERWRITE", scenarioCount: 99 });
    let run = await runRow(runId);
    expect(run.name).toBe("IT run");
    expect(run.scenario_count).toBe(4);
    expect(run.status).toBe("running");
    expect(run.agent_id).toBe(AGENT);
    expect(run.tenant_id).toBe(TENANT);

    // scenario 1: started → completed with a passing goal eval
    const rs1 = crypto.randomUUID();
    await insertRunScenario({ id: rs1, simRunId: runId, scenarioRef: "s1", scenarioIndex: 0 });
    await completeRunScenario({
      id: rs1, simRunId: runId, scenarioRef: "s1", scenarioIndex: 0,
      status: "completed", stopReason: "end_conversation", turnCount: 3,
      evaluation: EVAL_PASSED, transcript: [{ turn: 1, user: "Hello!", agent: "Hi" }],
    });

    // scenario 2: completed with all goals failed
    const rs2 = crypto.randomUUID();
    await insertRunScenario({ id: rs2, simRunId: runId, scenarioRef: "s2", scenarioIndex: 1 });
    await completeRunScenario({
      id: rs2, simRunId: runId, scenarioRef: "s2", scenarioIndex: 1,
      status: "completed", stopReason: "max_turns", turnCount: 25, evaluation: EVAL_FAILED,
    });

    // scenario 3: eval_error=true → completed_count moves, NEITHER pass/fail counter does
    const rs3 = crypto.randomUUID();
    await insertRunScenario({ id: rs3, simRunId: runId, scenarioRef: "s3", scenarioIndex: 2 });
    await completeRunScenario({
      id: rs3, simRunId: runId, scenarioRef: "s3", scenarioIndex: 2,
      status: "completed", stopReason: "end_conversation", turnCount: 2, evalError: true,
    });

    // scenario 4: terminal write WITHOUT a prior insert (ordering-safe upsert) + error status
    const rs4 = crypto.randomUUID();
    await completeRunScenario({
      id: rs4, simRunId: runId, scenarioRef: "s4", scenarioIndex: 3,
      status: "error", stopReason: "error", turnCount: 0, error: "boom",
    });

    run = await runRow(runId);
    expect(run.completed_count).toBe(4);
    expect(run.scenarios_passed).toBe(1); // only rs1 (ANY achieved)
    expect(run.scenarios_failed).toBe(1); // only rs2 (scored, none achieved)

    const [row4] = await sql`SELECT * FROM ao_sim_run_scenario WHERE id = ${rs4}`;
    expect((row4 as Record<string, unknown>).status).toBe("error");
    expect((row4 as Record<string, unknown>).error).toBe("boom");

    const [row1] = await sql`SELECT * FROM ao_sim_run_scenario WHERE id = ${rs1}`;
    const eval1 = (row1 as { evaluation: { goal_evaluation: { goals: unknown[] } } }).evaluation;
    expect(eval1.goal_evaluation.goals.length).toBe(2); // eval JSONB stored verbatim, not a string scalar
    expect((row1 as { transcript: unknown[] }).transcript.length).toBe(1);

    await finalizeRun(runId);
    run = await runRow(runId);
    expect(run.status).toBe("completed");
    expect(run.completed_at).not.toBeNull();

    // finalize/fail/cancel only flip a still-running run — completed stays completed.
    await failRun(runId, "late failure must not overwrite");
    expect((await runRow(runId)).status).toBe("completed");

    // cleanup
    await sql`DELETE FROM ao_sim_run_scenario WHERE sim_run_id = ${runId}`;
    await sql`DELETE FROM ao_sim_run WHERE id = ${runId}`;
  });

  test("failRun / cancelRun set terminal statuses on a running run", async () => {
    const failId = crypto.randomUUID();
    await upsertRun({ id: failId, tenantId: TENANT, agentId: AGENT });
    await failRun(failId, "flow JSON missing");
    let [row] = await sql`SELECT status, error_message FROM ao_sim_run WHERE id = ${failId}`;
    expect((row as Record<string, unknown>).status).toBe("failed");
    expect((row as Record<string, unknown>).error_message).toBe("flow JSON missing");

    const cancelId = crypto.randomUUID();
    await upsertRun({ id: cancelId, tenantId: TENANT, agentId: AGENT });
    await cancelRun(cancelId);
    [row] = await sql`SELECT status FROM ao_sim_run WHERE id = ${cancelId}`;
    expect((row as Record<string, unknown>).status).toBe("cancelled");

    await sql`DELETE FROM ao_sim_run WHERE id IN (${failId}, ${cancelId})`;
  });
});
