import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { LiveKitSimClient, LiveKitSimError } from "../src/sim-engine/run-engine/livekit-client.js";

// Stage 2: the /turn client against a real (ephemeral) fake livekit server — proves the request
// shape on the wire + correct response parsing + the error paths. No real livekit needed.

let server: ReturnType<typeof Bun.serve>;
let base = "";
// Captures what the fake server last received, so tests can assert the request shape.
let last: { path: string; auth: string | null; body: Record<string, unknown> } = { path: "", auth: null, body: {} };

const RESPONSE = {
  message: "Hi, how can I help?",
  intent: "greet",
  variables: { caller_name: "Sam" },
  tool_calls: [],
  response_items: [{ role: "assistant", content: "Hi" }],
  node_uuid: "n2",
  node_run_uuid: "nr2",
  ended: false,
  stop_reason: "",
  context_items: [{ idx: 1 }],
  variables_by_node: { n1: { x: 1 } },
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json()) as Record<string, unknown>;
      last = { path: url.pathname, auth: req.headers.get("authorization"), body };
      if (url.pathname !== "/v1/simulation/session/turn") return new Response("not found", { status: 404 });
      // A scenario-driven failure path: user_message "boom" → 500 with a body to preview.
      if (body.user_message === "boom") return new Response("kaboom internal error", { status: 500 });
      return Response.json(RESPONSE);
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server?.stop(true));

describe("LiveKitSimClient.executeTurn", () => {
  test("sends the right request shape and parses the response", async () => {
    const client = new LiveKitSimClient({ url: base });
    const res = await client.executeTurn({
      phlo_run_uuid: "run-1",
      node_uuid: "n1",
      node_run_uuid: "nr1",
      auth_id: "acct-1",
      user_message: "I need a refund",
      is_interruption: false,
      agent_config: { greeting: "hello" },
      variables_by_node: { n1: { x: 1 } },
    });

    // request shape on the wire
    expect(last.path).toBe("/v1/simulation/session/turn");
    expect(last.body).toMatchObject({
      phlo_run_uuid: "run-1",
      node_uuid: "n1",
      node_run_uuid: "nr1",
      auth_id: "acct-1",
      user_message: "I need a refund",
      is_interruption: false,
    });
    expect(last.body.agent_config).toEqual({ greeting: "hello" });

    // response parse
    expect(res.message).toBe("Hi, how can I help?");
    expect(res.intent).toBe("greet");
    expect(res.variables).toEqual({ caller_name: "Sam" });
    expect(res.ended).toBe(false);
    expect(res.response_items).toEqual([{ role: "assistant", content: "Hi" }]);
    expect(res.context_items).toEqual([{ idx: 1 }]);
    expect(res.variables_by_node).toEqual({ n1: { x: 1 } });
  });

  test("omits undefined optional fields from the wire body (Go omitempty), always sends is_interruption", async () => {
    const client = new LiveKitSimClient({ url: base });
    await client.executeTurn({
      phlo_run_uuid: "r",
      node_uuid: "n",
      node_run_uuid: "nr",
      auth_id: "a",
      is_interruption: true,
    });
    expect(last.body).not.toHaveProperty("user_message");
    expect(last.body).not.toHaveProperty("agent_config");
    expect(last.body).not.toHaveProperty("context_items");
    expect(last.body.is_interruption).toBe(true);
  });

  test("sends Basic auth only when credentials are provided", async () => {
    await new LiveKitSimClient({ url: base }).executeTurn({
      phlo_run_uuid: "r", node_uuid: "n", node_run_uuid: "nr", auth_id: "a", is_interruption: false,
    });
    expect(last.auth).toBeNull();

    await new LiveKitSimClient({ url: base, username: "u", password: "p" }).executeTurn({
      phlo_run_uuid: "r", node_uuid: "n", node_run_uuid: "nr", auth_id: "a", is_interruption: false,
    });
    expect(last.auth).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  test("throws LiveKitSimError with status + body preview on a non-200", async () => {
    const client = new LiveKitSimClient({ url: base });
    const call = client.executeTurn({
      phlo_run_uuid: "r", node_uuid: "n", node_run_uuid: "nr", auth_id: "a", is_interruption: false, user_message: "boom",
    });
    await expect(call).rejects.toThrow(/returned status 500: kaboom/);
    try {
      await client.executeTurn({
        phlo_run_uuid: "r", node_uuid: "n", node_run_uuid: "nr", auth_id: "a", is_interruption: false, user_message: "boom",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(LiveKitSimError);
      expect((e as LiveKitSimError).status).toBe(500);
    }
  });

  test("throws when the URL is not configured", async () => {
    const client = new LiveKitSimClient({ url: "" });
    await expect(
      client.executeTurn({ phlo_run_uuid: "r", node_uuid: "n", node_run_uuid: "nr", auth_id: "a", is_interruption: false }),
    ).rejects.toThrow(/not configured/);
  });
});
