import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { LiveKitSimClient, LiveKitSimError, type SimTurnRequest } from "../src/sim-engine/run-engine/livekit-client.js";

// SER-6447: the agent-runner sim client against an ephemeral fake server — proves the request
// shape on the wire matches SimTurnRequest exactly (no dead agent_config / is_interruption keys),
// the four surfaces (turn / flow-session / inventory) hit the right paths, the cookie jar keeps a
// task-unit session pinned, and the error paths. No real agent-runner needed.

let server: ReturnType<typeof Bun.serve>;
let base = "";
let last: { path: string; auth: string | null; cookie: string | null; body: Record<string, unknown> } = {
  path: "", auth: null, cookie: null, body: {},
};

const TURN_RESPONSE = {
  message: "Hi, how can I help?",
  intent: "greet",
  variables: { caller_name: "Sam" },
  tool_calls: [],
  response_items: [{ role: "assistant", content: "Hi" }],
  turn_node_uuid: "n1",
  node_uuid: "n2",
  node_run_uuid: "nr2",
  turn_count: 1,
  turn_type: "speech",
  transitions: [{ from_node_uuid: "n1", handle: "greet", via: [], to_node_uuid: "n2", to_type: "ai_agent_v2" }],
  ended: false,
  stop_reason: "",
  stop_detail: "",
  context_items: [{ idx: 1 }],
  variables_by_node: { n1: { x: 1 } },
};

const INVENTORY_RESPONSE = {
  nodes: [], routes: [], variables: [], actions: [], languages: [],
  is_outbound_call: false, simulatable: true, unsimulatable: [], entry_node_uuid: "n1",
  reachable_ai_nodes: ["n1"], mockable_nodes: [], terminals: [],
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json()) as Record<string, unknown>;
      last = { path: url.pathname, auth: req.headers.get("authorization"), cookie: req.headers.get("cookie"), body };
      if (url.pathname === "/v1/simulation/flow/inventory") return Response.json(INVENTORY_RESPONSE);
      if (body.user_message === "boom") return new Response("kaboom internal error", { status: 500 });
      // flow-session start issues a sticky cookie the client must resend on later turns.
      if (url.pathname === "/v1/simulation/flow-session/start") {
        return new Response(JSON.stringify(TURN_RESPONSE), {
          headers: { "content-type": "application/json", "set-cookie": "AWSALB=sticky123; Path=/" },
        });
      }
      return Response.json(TURN_RESPONSE);
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server?.stop(true));

const req = (over: Partial<SimTurnRequest> = {}): SimTurnRequest => ({
  phlo_run_uuid: "run-1",
  auth_id: "acct-1",
  flow: { nodes: [{ id: "n1", type: "ai_agent_v2" }], edges: [] },
  world_state: {},
  start_node_params: {},
  max_turns: 25,
  node_uuid: "n1",
  node_run_uuid: "nr1",
  turn_count: 0,
  user_message: "I need a refund",
  context_items: [],
  variables_by_node: { n1: { x: 1 } },
  ...over,
});

// Every key SimTurnRequest permits (agent-runner rejects anything else — extra="forbid").
const ALLOWED_KEYS = new Set([
  "phlo_run_uuid", "auth_id", "simulation_session_id", "flow", "world_state", "start_node_params",
  "max_turns", "node_uuid", "node_run_uuid", "turn_count", "user_message", "idle", "action_mocks",
  "context_items", "variables_by_node",
]);
const DEAD_KEYS = ["agent_config", "output_state_config", "is_interruption", "partial_assistant_message"];

describe("LiveKitSimClient.turn — wire contract", () => {
  test("the serialized body has ONLY SimTurnRequest keys and none of the dead ones", async () => {
    await new LiveKitSimClient({ url: base }).turn(req({ simulation_session_id: "s", action_mocks: { t: 1 } }));
    expect(last.path).toBe("/v1/simulation/session/turn");
    for (const key of Object.keys(last.body)) expect(ALLOWED_KEYS.has(key)).toBe(true);
    for (const dead of DEAD_KEYS) expect(last.body).not.toHaveProperty(dead);
    // the load-bearing fields are actually present
    expect(last.body).toMatchObject({ phlo_run_uuid: "run-1", auth_id: "acct-1", node_uuid: "n1", max_turns: 25, user_message: "I need a refund" });
    expect(last.body.flow).toBeDefined();
    expect(last.body.world_state).toEqual({});
  });

  test("parses the SimResponse (speaker, landing, transitions, stop fields)", async () => {
    const res = await new LiveKitSimClient({ url: base }).turn(req());
    expect(res.turn_node_uuid).toBe("n1");
    expect(res.node_uuid).toBe("n2");
    expect(res.turn_count).toBe(1);
    expect(res.turn_type).toBe("speech");
    expect(res.transitions[0]).toMatchObject({ from_node_uuid: "n1", to_node_uuid: "n2", to_type: "ai_agent_v2" });
    expect(res.ended).toBe(false);
    expect(res.variables_by_node).toEqual({ n1: { x: 1 } });
  });

  test("omits undefined optional fields from the wire body", async () => {
    await new LiveKitSimClient({ url: base }).turn({ phlo_run_uuid: "r", auth_id: "a", flow: {}, max_turns: 25 });
    expect(last.body).not.toHaveProperty("user_message");
    expect(last.body).not.toHaveProperty("context_items");
    expect(last.body).not.toHaveProperty("simulation_session_id");
  });
});

describe("flow-session lifecycle + cookie jar", () => {
  test("start issues a cookie the subsequent turn resends (sticky routing)", async () => {
    const client = new LiveKitSimClient({ url: base });
    await client.flowSessionStart(req({ simulation_session_id: "fs-1", user_message: undefined }));
    expect(last.path).toBe("/v1/simulation/flow-session/start");
    await client.flowSessionTurn(req({ simulation_session_id: "fs-1", user_message: "hello" }));
    expect(last.path).toBe("/v1/simulation/flow-session/turn");
    expect(last.cookie).toBe("AWSALB=sticky123");
    // a forgotten session no longer resends its cookie
    client.forgetSession("fs-1");
    await client.flowSessionTurn(req({ simulation_session_id: "fs-1", user_message: "again" }));
    expect(last.cookie).toBeNull();
  });
});

describe("inventory", () => {
  test("posts {flow, world_state} and returns the FlowInventory", async () => {
    const inv = await new LiveKitSimClient({ url: base }).inventory({ nodes: [] }, { "n-1": { outcome: "eligible" } });
    expect(last.path).toBe("/v1/simulation/flow/inventory");
    expect(last.body).toEqual({ flow: { nodes: [] }, world_state: { "n-1": { outcome: "eligible" } } });
    expect(inv.simulatable).toBe(true);
    expect(inv.entry_node_uuid).toBe("n1");
  });
});

describe("auth + error paths", () => {
  test("Basic auth only when credentials are provided", async () => {
    await new LiveKitSimClient({ url: base }).turn(req());
    expect(last.auth).toBeNull();
    await new LiveKitSimClient({ url: base, username: "u", password: "p" }).turn(req());
    expect(last.auth).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  test("throws LiveKitSimError with status + body preview on a non-200", async () => {
    const client = new LiveKitSimClient({ url: base });
    const call = client.turn(req({ user_message: "boom" }));
    await expect(call).rejects.toThrow(/returned status 500: kaboom/);
    try {
      await client.turn(req({ user_message: "boom" }));
    } catch (e) {
      expect(e).toBeInstanceOf(LiveKitSimError);
      expect((e as LiveKitSimError).status).toBe(500);
    }
  });

  test("throws when the URL is not configured", async () => {
    await expect(new LiveKitSimClient({ url: "" }).turn(req())).rejects.toThrow(/not configured/);
  });
});
