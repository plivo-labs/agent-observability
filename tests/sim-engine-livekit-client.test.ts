import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { LiveKitSimClient, LiveKitSimError, type SimTurnRequest } from "../src/sim-engine/run-engine/livekit-client.js";

// The agent-runner sim client against an ephemeral fake server — proves the request body on the
// wire is exactly SimTurnRequest (extra="forbid" allows nothing else), the three surfaces
// (turn / end / inventory) hit the right paths, a 410 maps to a run_lost error, and the error
// paths. No real agent-runner needed.

let server: ReturnType<typeof Bun.serve>;
let base = "";
let last: { path: string; auth: string | null; body: Record<string, unknown> } = { path: "", auth: null, body: {} };

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
  variables_by_node: { n1: { x: 1 } },
  next_speaker: "caller",
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
      last = { path: url.pathname, auth: req.headers.get("authorization"), body };
      if (url.pathname === "/v1/simulation/flow/inventory") return Response.json(INVENTORY_RESPONSE);
      if (url.pathname === "/v1/simulation/end") return Response.json({});
      // The run's owning replica is gone: agent-runner answers 410 {"error":"run_lost"}.
      if (body.phlo_run_uuid === "gone") return new Response(JSON.stringify({ error: "run_lost" }), { status: 410 });
      if (body.user_message === "boom") return new Response("kaboom internal error", { status: 500 });
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
  user_message: "I need a refund",
  ...over,
});

describe("LiveKitSimClient.turn — wire contract", () => {
  test("posts to /turn carrying ONLY the allowed SimTurnRequest keys", async () => {
    await new LiveKitSimClient({ url: base }).turn(req({ action_mocks: { t: 1 } }));
    expect(last.path).toBe("/v1/simulation/turn");
    // extra="forbid" on the server: no key outside this set may ever ride the wire.
    expect(Object.keys(last.body).sort()).toEqual(
      ["action_mocks", "auth_id", "flow", "max_turns", "phlo_run_uuid", "start_node_params", "user_message", "world_state"],
    );
    expect(last.body).toMatchObject({ phlo_run_uuid: "run-1", auth_id: "acct-1", max_turns: 25, user_message: "I need a refund" });
    expect(last.body.world_state).toEqual({});
  });

  test("parses the SimResponse (speaker, transitions, next_speaker, stop fields)", async () => {
    const res = await new LiveKitSimClient({ url: base }).turn(req());
    expect(res.turn_node_uuid).toBe("n1");
    expect(res.turn_count).toBe(1);
    expect(res.turn_type).toBe("speech");
    expect(res.transitions[0]).toMatchObject({ from_node_uuid: "n1", to_node_uuid: "n2", to_type: "ai_agent_v2" });
    expect(res.ended).toBe(false);
    expect(res.next_speaker).toBe("caller");
    expect(res.variables_by_node).toEqual({ n1: { x: 1 } });
  });

  test("omits undefined optional fields from the wire body", async () => {
    await new LiveKitSimClient({ url: base }).turn({ phlo_run_uuid: "r", auth_id: "a", flow: {}, max_turns: 25 });
    expect(last.body).not.toHaveProperty("user_message");
    expect(last.body).not.toHaveProperty("action_mocks");
    expect(last.body).not.toHaveProperty("world_state");
  });
});

describe("end", () => {
  test("posts {phlo_run_uuid, auth_id} to /end", async () => {
    await new LiveKitSimClient({ url: base }).end("run-9", "acct");
    expect(last.path).toBe("/v1/simulation/end");
    expect(last.body).toEqual({ phlo_run_uuid: "run-9", auth_id: "acct" });
  });

  test("no-op (no request) when the URL is unset or the run id is empty", async () => {
    last = { path: "__none__", auth: null, body: {} };
    await new LiveKitSimClient({ url: "" }).end("run-9", "acct");
    await new LiveKitSimClient({ url: base }).end("", "acct");
    expect(last.path).toBe("__none__");
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

  test("maps a 410 to a LiveKitSimError flagged run_lost", async () => {
    const client = new LiveKitSimClient({ url: base });
    try {
      await client.turn(req({ phlo_run_uuid: "gone" }));
      throw new Error("expected the 410 to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LiveKitSimError);
      expect((e as LiveKitSimError).status).toBe(410);
      expect((e as LiveKitSimError).runLost).toBe(true);
    }
  });

  test("throws LiveKitSimError with status + body preview on a non-200 (not run_lost)", async () => {
    const client = new LiveKitSimClient({ url: base });
    await expect(client.turn(req({ user_message: "boom" }))).rejects.toThrow(/returned status 500: kaboom/);
    try {
      await client.turn(req({ user_message: "boom" }));
    } catch (e) {
      expect(e).toBeInstanceOf(LiveKitSimError);
      expect((e as LiveKitSimError).status).toBe(500);
      expect((e as LiveKitSimError).runLost).toBe(false);
    }
  });

  test("throws when the URL is not configured", async () => {
    await expect(new LiveKitSimClient({ url: "" }).turn(req())).rejects.toThrow(/not configured/);
  });
});
