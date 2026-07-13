/**
 * Regression suite for the 2026-07-13 bun-runtime jsonb corruption, sim-engine
 * edition: bun:sql 1.2.23 serialized JS ARRAYS bound to raw `::jsonb` params as
 * PG array literals — invalid-JSON STRING scalars in the stored column (this
 * corrupted chat_history in dev; AO PR #97 patched the ingest/eval/alert
 * writers, this suite covers the ao_sim_* writers ported in this PR). All sim
 * jsonb params now bind via jsonbParam() + ::text::jsonb — Postgres parses the
 * JSON, which is bun-version-independent. Tests pin the stored SHAPE
 * (jsonb_typeof), not just round-trip equality, so a future binding regression
 * is caught even on a bun version where round-trip happens to work.
 */
import { test, expect, afterAll } from "bun:test";
import { sql } from "../src/db.js";
import { jsonbParam } from "../src/jsonb-param.js";
import {
  createScenario,
  getScenariosByIds,
  deleteScenarios,
  completeRunScenario,
} from "../src/sim-engine/db.js";
import { describeDb } from "./helpers.js";

const TENANT = "itest-jsonb-shapes";
const RUN_ID = "00000000-0000-4000-8000-00000000a001";
const RUN_SCENARIO_ID = "00000000-0000-4000-8000-00000000a002";

afterAll(async () => {
  await sql`DELETE FROM ao_sim_scenario WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM ao_sim_run_scenario WHERE id = ${RUN_SCENARIO_ID}::uuid`;
});

describeDb("sim-engine jsonb param binding shapes", () => {
  test("jsonbParam: null/undefined stay SQL NULL; values stringify", () => {
    expect(jsonbParam(null)).toBeNull();
    expect(jsonbParam(undefined)).toBeNull();
    expect(jsonbParam(["a", "b"])).toBe('["a","b"]');
    expect(jsonbParam({ goal: "g" })).toBe('{"goal":"g"}');
  });

  test("createScenario stores scenario as jsonb OBJECT and tags as jsonb ARRAY", async () => {
    const row = await createScenario({
      tenantId: TENANT,
      agentId: "itest-agent",
      name: "shape probe",
      scenario: { id: "s1", goal: "check shapes", tags: ["x"] },
      tags: ["alpha", "beta"],
    });
    const [shapes] = await sql`
      SELECT jsonb_typeof(scenario) AS scenario_shape, jsonb_typeof(tags) AS tags_shape
      FROM ao_sim_scenario WHERE id = ${row.id}::uuid
    `;
    // The 1.2.23 regression stored 'string' for the ARRAY bind — the console's
    // tags rendering and every tags-consuming reader would die on it.
    expect(shapes.scenario_shape).toBe("object");
    expect(shapes.tags_shape).toBe("array");
  });

  test("ids-array membership (getScenariosByIds / deleteScenarios) works via jsonbParam", async () => {
    const a = await createScenario({
      tenantId: TENANT,
      agentId: "itest-agent",
      name: "member a",
      scenario: { id: "a" },
      tags: [],
    });
    const b = await createScenario({
      tenantId: TENANT,
      agentId: "itest-agent",
      name: "member b",
      scenario: { id: "b" },
      tags: [],
    });
    // On 1.2.23 the raw array bind made jsonb_array_elements_text() blow up on a
    // string scalar — membership reads and bulk deletes would 500.
    const fetched = await getScenariosByIds([a.id, b.id]);
    expect(fetched.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(await deleteScenarios([a.id, b.id], TENANT)).toBe(2);
  });

  test("completeRunScenario stores evaluation as OBJECT and transcript as ARRAY (both paths)", async () => {
    await sql`DELETE FROM ao_sim_run_scenario WHERE id = ${RUN_SCENARIO_ID}::uuid`;
    // UPDATE misses (no row) → INSERT fallback path binds evaluation + transcript.
    await completeRunScenario({
      id: RUN_SCENARIO_ID,
      simRunId: RUN_ID,
      scenarioRef: "ref-1",
      scenarioIndex: 0,
      status: "completed",
      stopReason: "goal_reached",
      turnCount: 2,
      evaluation: { node_evaluations: [], goal_evaluation: { goals: [] } },
      transcript: [{ turn: 1 }, { turn: 2 }],
    });
    const [ins] = await sql`
      SELECT jsonb_typeof(evaluation) AS eval_shape, jsonb_typeof(transcript) AS transcript_shape
      FROM ao_sim_run_scenario WHERE id = ${RUN_SCENARIO_ID}::uuid
    `;
    expect(ins.eval_shape).toBe("object");
    expect(ins.transcript_shape).toBe("array");

    // Second call hits the UPDATE path on the now-existing row.
    await completeRunScenario({
      id: RUN_SCENARIO_ID,
      simRunId: RUN_ID,
      status: "completed",
      turnCount: 3,
      evaluation: { node_evaluations: [{ node: "n1" }] },
      transcript: [{ turn: 1 }, { turn: 2 }, { turn: 3 }],
    });
    const [upd] = await sql`
      SELECT jsonb_typeof(evaluation) AS eval_shape, jsonb_typeof(transcript) AS transcript_shape,
             jsonb_array_length(transcript) AS turns
      FROM ao_sim_run_scenario WHERE id = ${RUN_SCENARIO_ID}::uuid
    `;
    expect(upd.eval_shape).toBe("object");
    expect(upd.transcript_shape).toBe("array");
    expect(upd.turns).toBe(3);
  });

  test("null evaluation stays SQL NULL (not the jsonb string 'null')", async () => {
    await completeRunScenario({
      id: RUN_SCENARIO_ID,
      simRunId: RUN_ID,
      status: "error",
      error: "boom",
      evaluation: null,
      transcript: [],
    });
    const [row] = await sql`
      SELECT evaluation IS NULL AS eval_is_sql_null, jsonb_typeof(transcript) AS transcript_shape
      FROM ao_sim_run_scenario WHERE id = ${RUN_SCENARIO_ID}::uuid
    `;
    expect(row.eval_is_sql_null).toBe(true);
    expect(row.transcript_shape).toBe("array");
  });
});
