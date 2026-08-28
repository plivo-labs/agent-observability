import { describe, test, expect, afterAll, mock, spyOn } from "bun:test";
import { Redis } from "ioredis";
import * as lkMod from "../src/sim-engine/run-engine/livekit-client.js";

// Phase 4 scenario-library routes against real PG (migration 019) + real Redis, with the LLM
// generator mocked (a canned generateScenarios — no LLM):
// Run: DATABASE_URL=... REDIS_URL=redis://127.0.0.1:6379 bun test tests-integration/sim-routes.test.ts

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

function fakeScenario(scnId: string, idx: number) {
  return {
    id: scnId,
    name: `Scenario ${idx}`,
    persona: { personality: "calm", emotional_state: "neutral", behavioral_traits: [], details: {} },
    goal: `goal ${idx}`,
    language: "en-US",
    world_state: {},
    start_node_params: {},
    interruption: { enabled: false, probability: 0 },
    stt_noise: { enabled: false, severity: "light" },
    non_answer: { enabled: false, probability: 0 },
    tags: ["clean_baseline"],
    eval_metadata: { coverage_key: `cov-${idx}`, slot_id: `S00${idx + 1}` },
    agent_flow_description: "Test agent.",
  };
}

// Mocks must be installed before importing routes.js (which imports the generator).
mock.module("../src/sim-engine/gen/generate.js", () => ({
  // eslint-disable-next-line require-yield
  async *generateScenarios() {
    yield { type: "planning_started", attempt: 1, existing_summary_count: 0 };
    yield { type: "planning_done", attempt: 1, capability_count: 1 };
    yield { type: "allocation_started", attempt: 1, capability_count: 1 };
    yield { type: "allocation_done", attempt: 1, planned_count: 2 };
    yield { type: "writing_started", planned_count: 2, chunk_count: 1, chunk_size: 10 };
    for (let i = 0; i < 2; i++) {
      yield { type: "scenario", scenario: fakeScenario(crypto.randomUUID(), i) };
      yield { type: "writer_scenario_done", chunk_index: 0, chunk_count: 1, scenario_index: i, saved_count: i + 1, slot_id: `S00${i + 1}` };
    }
    yield { type: "writer_chunk_done", chunk_index: 0, chunk_count: 1, chunk_saved_count: 2, failed_slot_ids: [] };
    yield { type: "metadata", metadata: { requested_count: 2, planned_count: 2, saved_count: 2, failed_count: 0, failed_slot_ids: [], partial_success: false, planner_usage: null, writer_usages: [] } };
  },
}));

// The generate route dry-runs the flow through agent-runner's inventory before streaming. Stub it
// simulatable so these library/persist tests exercise generation, not the walk.
spyOn(lkMod, "makeLiveKitSimClient").mockReturnValue({
  inventory: async () => ({
    simulatable: true, unsimulatable: [], nodes: [], routes: [], variables: [], actions: [],
    languages: [], is_outbound_call: false, entry_node_uuid: "n-greet", reachable_ai_nodes: ["n-greet"],
    mockable_nodes: [], terminals: [],
  }),
} as any);

const { Hono } = await import("hono");
const { registerSimulationRoutes } = await import("../src/sim-engine/routes.js");
const { sql } = await import("../src/db.js");
const realShape = (await import("../tests/fixtures/flow-real-shape.json")).default;

async function probe(): Promise<Redis | null> {
  const c = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try { await c.connect(); await c.ping(); return c; } catch { c.disconnect(); return null; }
}
const client = await probe();
const suite = client ? describe : describe.skip;
if (!client) console.warn(`[sim-routes] no Redis at ${REDIS_URL} — skipping`);

const app = new Hono();
registerSimulationRoutes(app);
const H = { "content-type": "application/json", "auth-id": "acct-routes" };

afterAll(async () => {
  if (client) await client.quit();
  // Do NOT close the shared `sql` pool — sibling integration suites still use it.
});

/** Parse SSE "event:"/"data:" blocks from a fully-buffered stream body. */
function parseSSE(text: string): { event: string; data: string }[] {
  const out: { event: string; data: string }[] = [];
  for (const block of text.split("\n\n")) {
    let event = "", data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (event) out.push({ event, data });
  }
  return out;
}

suite("simulation routes", () => {
  test("generate (SSE): streams progress + scenario_saved + completed, persists scenarios", async () => {
    // idempotent across re-runs: clear any phlo-gen rows left by a prior run first
    await app.fetch(new Request("http://localhost/api/simulation/scenarios?phlo_uuid=phlo-gen", { method: "DELETE", headers: H }));
    const res = await app.fetch(new Request("http://localhost/api/simulation/scenarios/generate", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ flow_json: realShape, phlo_uuid: "phlo-gen", max_scenarios: 2 }),
    }));
    expect(res.status).toBe(200);
    const events = parseSSE(await res.text());
    const names = events.map((e) => e.event);
    expect(names).toContain("progress");
    expect(names.filter((n) => n === "scenario_saved").length).toBe(2);
    expect(names).toContain("completed");
    // progress carries event_data.stage. The first progress frame is now an immediate keep-alive
    // heartbeat (primes the aiassist relay's Redis connection before the silent planner gap); the
    // real planning_started progress follows.
    const firstProgress = events.find((e) => e.event === "progress")!;
    expect(JSON.parse(firstProgress.data).event_data.stage).toBe("heartbeat");
    const planningStarted = events.find(
      (e) => e.event === "progress" && JSON.parse(e.data).event_data.stage === "planning_started",
    );
    expect(planningStarted).toBeTruthy();

    // persisted to ao_sim_scenario → visible via the list route
    const list = await app.fetch(new Request("http://localhost/api/simulation/scenarios?phlo_uuid=phlo-gen", { headers: H }));
    const body = await list.json();
    expect(body.total).toBe(2);
    expect(body.scenarios.length).toBe(2);
    expect(body.scenarios[0].uuid).toBeTruthy();

    // persisted scenario_saved events carry the durable row uuid (scenario_uuid) so a stateless
    // relayer (the orchestrator service) can surface the library id without its own DB write.
    const savedUuids = events
      .filter((e) => e.event === "scenario_saved")
      .map((e) => JSON.parse(e.data).event_data.scenario_uuid)
      .sort();
    const listedUuids = body.scenarios.map((s: { uuid: string }) => s.uuid).sort();
    expect(savedUuids).toEqual(listedUuids);
  });

  test("generate ?persist=false: streams scenarios (full payload) but writes NO DB rows", async () => {
    const res = await app.fetch(new Request("http://localhost/api/simulation/scenarios/generate?persist=false", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ flow_json: realShape, phlo_uuid: "phlo-nopersist", max_scenarios: 2 }),
    }));
    expect(res.status).toBe(200);
    const events = parseSSE(await res.text());
    const saved = events.filter((e) => e.event === "scenario_saved");
    expect(saved.length).toBe(2); // scenarios still stream — aiassist persists them
    expect(JSON.parse(saved[0]!.data).event_data.scenario).toBeTruthy(); // full scenario rides the event
    expect(JSON.parse(saved[0]!.data).event_data.scenario_uuid).toBeUndefined(); // no row → no durable uuid
    expect(events.map((e) => e.event)).toContain("completed");

    // AO wrote nothing to its own table under persist=false
    const list = await app.fetch(new Request("http://localhost/api/simulation/scenarios?phlo_uuid=phlo-nopersist", { headers: H }));
    expect((await list.json()).total).toBe(0);
  });

  test("invalid generate body → 400 before streaming", async () => {
    const res = await app.fetch(new Request("http://localhost/api/simulation/scenarios/generate", {
      method: "POST", headers: H, body: JSON.stringify({ phlo_uuid: "x" }), // missing flow_json
    }));
    expect(res.status).toBe(400);
  });

  test("delete is account-scoped — another tenant cannot delete by uuid (IDOR fix)", async () => {
    // clean any leftovers from a prior run, then tenant A (acct-routes) generates 2
    await app.fetch(new Request("http://localhost/api/simulation/scenarios?phlo_uuid=phlo-idor", { method: "DELETE", headers: H }));
    await (await app.fetch(new Request("http://localhost/api/simulation/scenarios/generate", {
      method: "POST", headers: H, body: JSON.stringify({ flow_json: realShape, phlo_uuid: "phlo-idor", max_scenarios: 2 }),
    }))).text();
    const uuid = (await (await app.fetch(new Request("http://localhost/api/simulation/scenarios?phlo_uuid=phlo-idor", { headers: H }))).json()).scenarios[0].uuid;
    expect(uuid).toBeTruthy();

    // tenant B (different auth-id) cannot delete A's scenario: single → 404, batch → 0 deleted
    const Hb = { "content-type": "application/json", "auth-id": "acct-other" };
    const single = await app.fetch(new Request(`http://localhost/api/simulation/scenarios/${uuid}`, { method: "DELETE", headers: Hb }));
    expect(single.status).toBe(404);
    const batch = await (await app.fetch(new Request("http://localhost/api/simulation/scenarios/batch-delete", { method: "POST", headers: Hb, body: JSON.stringify({ uuids: [uuid] }) }))).json();
    expect(batch.deleted_count).toBe(0);

    // still present for A; A can delete its own (200)
    expect((await (await app.fetch(new Request("http://localhost/api/simulation/scenarios?phlo_uuid=phlo-idor", { headers: H }))).json()).total).toBe(2);
    const ok = await app.fetch(new Request(`http://localhost/api/simulation/scenarios/${uuid}`, { method: "DELETE", headers: H }));
    expect(ok.status).toBe(200);
  });

  test("batch-delete validates", async () => {
    const bad = await app.fetch(new Request("http://localhost/api/simulation/scenarios/batch-delete", { method: "POST", headers: H, body: JSON.stringify({ uuids: [] }) }));
    expect(bad.status).toBe(400);
  });
});
