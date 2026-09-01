import { describe, test, expect, spyOn, mock, beforeEach, afterAll } from "bun:test";
import * as lkMod from "../src/sim-engine/run-engine/livekit-client.js";
import * as genMod from "../src/sim-engine/gen/generate.js";
import { Hono } from "hono";
import { registerSimulationRoutes } from "../src/sim-engine/routes.js";

// The generate route dry-runs the flow through agent-runner's inventory ONCE, pre-stream, and
// refuses an unsimulatable flow. Spied so it needs neither agent-runner nor an LLM (restored in
// afterAll so the stubs don't leak to sibling files).
const realShape = (await import("./fixtures/flow-real-shape.json")).default;

const SIMULATABLE = {
  simulatable: true, unsimulatable: [], nodes: [], routes: [], variables: [], actions: [],
  languages: [], is_outbound_call: false, entry_node_uuid: "n-greet", reachable_ai_nodes: ["n-greet"],
  mockable_nodes: [], terminals: [],
};

let inventory: any = SIMULATABLE;
let inventoryCalls = 0;
let inventoryThrows = false;
let genArg: any;
spyOn(lkMod, "makeLiveKitSimClient").mockReturnValue({
  inventory: async () => {
    inventoryCalls += 1;
    if (inventoryThrows) throw new Error("agent-runner unreachable");
    return inventory;
  },
} as any);
spyOn(genMod, "generateScenarios").mockImplementation(async function* (opts: any) {
  genArg = opts;
  yield { type: "metadata", metadata: { saved_count: 0, requested_count: 0, planned_count: 0, failed_count: 0, failed_slot_ids: [], partial_success: false, planner_usage: null, writer_usages: [] } } as any;
});
afterAll(() => mock.restore());

const app = new Hono();
registerSimulationRoutes(app);

function generate() {
  return app.fetch(
    new Request("http://localhost/api/simulation/scenarios/generate", {
      method: "POST",
      headers: { "content-type": "application/json", "auth-id": "acct" },
      body: JSON.stringify({ phlo_uuid: "p", flow_json: realShape, max_scenarios: 2 }),
    }),
  );
}

beforeEach(() => {
  inventory = SIMULATABLE;
  inventoryCalls = 0;
  inventoryThrows = false;
  genArg = undefined;
});

describe("generate route — inventory gate (SER-6447)", () => {
  test("unsimulatable flow → 400 flow_not_simulatable with the node list", async () => {
    inventory = { ...SIMULATABLE, simulatable: false, unsimulatable: [{ node_uuid: "n-mp", name: "Outbound call", type: "multi_party_call", reason: "unsupported node" }] };
    const res = await generate();
    expect(res.status).toBe(400);
    const j = (await res.json()) as any;
    expect(j.error.code).toBe("flow_not_simulatable");
    expect(j.unsimulatable[0].node_uuid).toBe("n-mp");
    expect(inventoryCalls).toBe(1);
  });

  test("walker's unsimulatable_reason leads the 400 detail", async () => {
    inventory = {
      ...SIMULATABLE,
      simulatable: false,
      unsimulatable: [],
      unsimulatable_reason: 'AI node(s) "Name Capture Agent" have no outgoing route — wire at least one intent or edge to a next node (e.g. an End conversation node)',
    };
    const res = await generate();
    expect(res.status).toBe(400);
    const j = (await res.json()) as any;
    expect(j.error.message).toContain('"Name Capture Agent" have no outgoing route');
    expect(j.error.message).not.toContain("no start node, or no reachable");
  });

  test("agent-runner unreachable → 502 flow_inventory_failed", async () => {
    inventoryThrows = true;
    const res = await generate();
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.code).toBe("flow_inventory_failed");
  });

  test("simulatable flow → streams (200), inventory called exactly once", async () => {
    const res = await generate();
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE body
    expect(inventoryCalls).toBe(1);
    expect(genArg.inventory).toBe(inventory);
  });
});
