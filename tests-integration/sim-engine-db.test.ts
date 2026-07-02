import { describe, test, expect, afterAll } from "bun:test";
import { sql } from "../src/db.js";
import {
  createScenario,
  getScenario,
  getScenariosByIds,
  listScenarios,
  deleteScenarios,
} from "../src/sim-engine/db.js";

// Integration test for the ao_simulation_scenarios accessors. Run with a DATABASE_URL
// pointed at a Postgres that has migration 019 applied:
//   DATABASE_URL=postgres://observability:observability@localhost:5433/ao_sim_it \
//     bun test tests-integration/sim-engine-db.test.ts

const ACCOUNT = "it-account";
const AGENT = "it-agent-phlo-uuid";

// NOTE: never close the shared `sql` pool here — the other integration suites in
// this process still need it (see tests-integration/helpers.ts).

describe("ao_simulation_scenarios accessors", () => {
  test("scenario CRUD: create (with tags) → fetch by id → list → delete", async () => {
    const s = await createScenario({
      accountId: ACCOUNT,
      agentId: AGENT,
      name: "happy path refund",
      scenario: { id: "s1", goal: "refund", world_state: { "n-check": { outcome: "eligible", data: {} } } },
      tags: ["happy", "refund"],
      coverageKey: "C1|P01",
    });
    expect(s.tags).toEqual(["happy", "refund"]); // text[] round-trips
    expect(s.source).toBe("generated");

    expect((await getScenario(s.id))?.name).toBe("happy path refund");

    const byIds = await getScenariosByIds([s.id]); // uuid[] binding
    expect(byIds.length).toBe(1);
    expect(byIds[0].coverage_key).toBe("C1|P01");

    const listed = await listScenarios({ agentId: AGENT, limit: 50, offset: 0 });
    expect(listed.objects.some((row) => row.id === s.id)).toBe(true);

    expect(await deleteScenarios([s.id])).toBe(1);
    expect(await getScenario(s.id)).toBeNull();
  });
});
