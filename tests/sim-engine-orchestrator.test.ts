import { describe, test, expect, spyOn, mock, beforeEach, afterAll } from "bun:test";
import type { SimResponse } from "../src/sim-engine/run-engine/livekit-client.js";
import * as dbMod from "../src/sim-engine/db.js";
import * as adapterMod from "../src/evals-engine/integration/sim-adapter.js";
import { MockLLM } from "../src/llm/index.js";
import { runScenario } from "../src/sim-engine/run-engine/orchestrator.js";

// SER-6447: the orchestrator turn loop against a scripted agent-runner client + user-simulator.
// Covers transcript attribution on turn_node_uuid, the empty-user greeting-turn rule, judges
// skipped at zero turns, and stop_detail → the `error` column only on abort reasons.
//
// db + the judge adapter are spied (restored in afterAll so the stubs don't leak to sibling test
// files): completeRunScenario captured for the error-column assertion, evaluateSimulationForRun
// stubbed + counted for the zero-turn skip. The turn loop is what's under test.
let evalCalls = 0;
const completeCalls: any[] = [];
spyOn(dbMod, "insertRunScenario").mockImplementation(async () => {});
spyOn(dbMod, "completeRunScenario").mockImplementation(async (input: any) => { completeCalls.push(input); });
spyOn(adapterMod, "evaluateSimulationForRun").mockImplementation(async () => { evalCalls += 1; return {}; });
afterAll(() => mock.restore());

type Ev = { type: string; event_data: any };

function fakeRedis(events: Ev[]) {
  return {
    xadd: async (...args: any[]) => {
      events.push({ type: args[3], event_data: JSON.parse(args[5]).event_data });
      return "1-0";
    },
    expire: async () => 1,
  } as any;
}

class FakeClient {
  requests: Array<{ method: string; req: any }> = [];
  private i = 0;
  constructor(private script: SimResponse[]) {}
  private next(): SimResponse {
    const r = this.script[this.i++];
    if (!r) throw new Error(`FakeClient: no scripted response for call #${this.i}`);
    return r;
  }
  forgotten: string[] = [];
  ended: string[] = [];
  async turn(req: any) { this.requests.push({ method: "turn", req }); return this.next(); }
  async flowSessionStart(req: any) { this.requests.push({ method: "start", req }); return this.next(); }
  async flowSessionTurn(req: any) { this.requests.push({ method: "fturn", req }); return this.next(); }
  async flowSessionEnd(id: string) { this.ended.push(id); }
  forgetSession(id: string) { this.forgotten.push(id); }
}

const resp = (over: Partial<SimResponse>): SimResponse => ({
  message: "", intent: "", variables: {}, tool_calls: [], response_items: [],
  turn_node_uuid: "", node_uuid: "", node_run_uuid: "nr", turn_count: 0, turn_type: "speech",
  transitions: [], ended: false, stop_reason: "", stop_detail: "", context_items: [], variables_by_node: {},
  ...over,
});

const FLOW = JSON.stringify({
  nodes: [
    { id: "A1", type: "ai_agent_v2", data: { config: { name: "A1" } } },
    { id: "A2", type: "ai_agent_v2", data: { config: { name: "A2" } } },
    { id: "S1", type: "contact_screening", data: { config: { name: "Screen" } } },
  ],
  edges: [],
});

const SCENARIO: any = {
  id: "sc", name: "Test", goal: "get help", language: "en-US",
  persona: { personality: "calm", emotional_state: "neutral", behavioral_traits: [], details: {} },
  interruption: { enabled: false, probability: 0 },
  stt_noise: { enabled: false, severity: "light" },
  non_answer: { enabled: false, probability: 0 },
  world_state: {}, start_node_params: {}, max_turns: 25, tags: [],
};

function job(over: Partial<any> = {}) {
  return {
    simRunUuid: "run", scenarioId: "sc", scenarioIndex: 0, scenario: SCENARIO,
    authId: "auth", agentFlowDescription: "", flowJson: FLOW, maxTurns: 25,
    dbPersist: { tenantId: "t", agentId: "a" }, scenarioRef: "ref", ...over,
  };
}

function deps(client: FakeClient, events: Ev[], userLines: string[]) {
  return {
    redis: fakeRedis(events),
    livekit: client as any,
    rng: () => 0.5,
    llmProvider: new MockLLM(userLines.map((m) => JSON.stringify({ message: m }))),
    llmModel: "m",
  };
}

beforeEach(() => {
  evalCalls = 0;
  completeCalls.length = 0;
});

describe("runScenario turn loop", () => {
  test("zero-turn terminal entry: judges skipped, no turn events, error column null", async () => {
    const client = new FakeClient([
      resp({
        turn_node_uuid: "", node_uuid: "", ended: true, stop_reason: "end_conversation", turn_type: "transition",
        transitions: [{ from_node_uuid: "start", handle: "call", via: [{ node_uuid: "h1", type: "http_request", outcome: "success" }], to_node_uuid: null, to_type: "end_conversation" }],
      }),
    ]);
    const events: Ev[] = [];
    await runScenario(deps(client, events, []), job());

    expect(evalCalls).toBe(0); // turn_count === 0 ⇒ judges skipped
    expect(events.filter((e) => e.type === "turn_completed")).toHaveLength(0);
    const done = events.find((e) => e.type === "scenario_completed")!.event_data;
    expect(done.turns).toBe(0);
    expect(done.stop_reason).toBe("end_conversation");
    expect(done.nodes_visited).toBe(2); // start + h1
    expect(done.evaluation).toBeUndefined();
    // end_conversation is not an abort ⇒ error stays null so the row still counts.
    expect(completeCalls[0].status).toBe("completed");
    expect(completeCalls[0].error).toBeNull();
  });

  test("greeting + node-switch greeting: transcript keyed on the SPEAKER, greetings unprompted", async () => {
    const client = new FakeClient([
      resp({ turn_node_uuid: "A1", node_uuid: "A1", turn_type: "transition", message: "Hello from A1", transitions: [{ from_node_uuid: "start", handle: "call", via: [], to_node_uuid: "A1", to_type: "ai_agent_v2" }] }),
      resp({ turn_node_uuid: "A1", node_uuid: "A2", turn_type: "speech", message: "Transferring you", intent: "go_a2", turn_count: 1, transitions: [{ from_node_uuid: "A1", handle: "go_a2", via: [], to_node_uuid: "A2", to_type: "ai_agent_v2" }] }),
      resp({ turn_node_uuid: "A2", node_uuid: "A2", turn_type: "transition", message: "Hi, A2 here", turn_count: 1 }),
      resp({ turn_node_uuid: "A2", node_uuid: "A2", turn_type: "speech", message: "Goodbye", intent: "done", ended: true, stop_reason: "end_conversation", turn_count: 2, transitions: [{ from_node_uuid: "A2", handle: "done", via: [], to_node_uuid: null, to_type: "end_conversation" }] }),
    ]);
    const events: Ev[] = [];
    await runScenario(deps(client, events, ["caller to A1", "caller to A2"]), job());

    const turns = events.filter((e) => e.type === "turn_completed").map((e) => e.event_data);
    expect(turns).toHaveLength(4);
    // entry greeting: empty caller line, A1 speaks
    expect(turns[0]).toMatchObject({ node_uuid: "A1", user: "", agent: "Hello from A1" });
    // the intent turn is attributed to the SPEAKER A1 even though the walk landed on A2
    expect(turns[1]).toMatchObject({ node_uuid: "A1", user: "caller to A1", agent: "Transferring you", intent: "go_a2" });
    // node-switch greeting: A2 speaks first, empty caller line
    expect(turns[2]).toMatchObject({ node_uuid: "A2", user: "", agent: "Hi, A2 here" });
    expect(turns[3]).toMatchObject({ node_uuid: "A2", user: "caller to A2", agent: "Goodbye", intent: "done" });

    // greetings are unprompted: the two turn() calls with a caller line are #2 (A1) and #4 (A2).
    const withUser = client.requests.filter((r) => r.req.user_message);
    expect(withUser.map((r) => r.req.node_uuid)).toEqual(["A1", "A2"]);
    // the greeting call for the new node A2 carried an empty user_message
    expect(client.requests[2].req).toMatchObject({ node_uuid: "A2", user_message: "" });

    const done = events.find((e) => e.type === "scenario_completed")!.event_data;
    expect(done.turns).toBe(2);
    expect(evalCalls).toBe(1);
    expect(completeCalls[0].error).toBeNull();
  });

  test("abort reason writes stop_detail into the error column (status stays completed)", async () => {
    const detail = 'no edge for intent "weird" at "A1"';
    const client = new FakeClient([
      resp({ turn_node_uuid: "A1", node_uuid: "A1", turn_type: "transition", message: "Hello", transitions: [{ from_node_uuid: "start", handle: "call", via: [], to_node_uuid: "A1", to_type: "ai_agent_v2" }] }),
      resp({ turn_node_uuid: "A1", node_uuid: "A1", turn_type: "speech", intent: "weird", ended: true, stop_reason: "unknown_intent", stop_detail: detail, turn_count: 1 }),
    ]);
    const events: Ev[] = [];
    await runScenario(deps(client, events, ["say something weird"]), job());

    const done = events.find((e) => e.type === "scenario_completed")!.event_data;
    expect(done.stop_reason).toBe("unknown_intent");
    expect(done.stop_detail).toBe(detail);
    expect(completeCalls[0].status).toBe("completed");
    expect(completeCalls[0].error).toBe(detail); // abort ⇒ detail rides in the error column
    expect(completeCalls[0].stopReason).toBe("unknown_intent");
  });

  test("mid-flow task unit: flow-session opener + exit threads the landing node", async () => {
    const client = new FakeClient([
      // entry greeting on A1
      resp({ turn_node_uuid: "A1", node_uuid: "A1", turn_type: "transition", message: "Hi from A1", transitions: [{ from_node_uuid: "start", handle: "call", via: [], to_node_uuid: "A1", to_type: "ai_agent_v2" }] }),
      // A1 fires an intent whose walk lands on the screening node
      resp({ turn_node_uuid: "A1", node_uuid: "S1", turn_type: "speech", message: "Let me verify you", intent: "screen", turn_count: 1, transitions: [{ from_node_uuid: "A1", handle: "screen", via: [], to_node_uuid: "S1", to_type: "contact_screening" }] }),
      // flowSessionStart opener (turn_count defaults to 0 — must NOT reset the accumulated count)
      resp({ turn_node_uuid: "S1", node_uuid: "S1", turn_type: "transition", message: "Am I speaking with Sam?" }),
      // flowSessionTurn exits the unit to A2 (ended stays false; the walk resolved the landing)
      resp({ turn_node_uuid: "S1", node_uuid: "A2", turn_type: "speech", message: "Thanks, connecting you", intent: "reached", turn_count: 2, transitions: [{ from_node_uuid: "S1", handle: "reached", via: [], to_node_uuid: "A2", to_type: "ai_agent_v2" }] }),
      // stateless greeting on A2, then end
      resp({ turn_node_uuid: "A2", node_uuid: "A2", turn_type: "transition", message: "A2 here", turn_count: 2 }),
      resp({ turn_node_uuid: "A2", node_uuid: "A2", turn_type: "speech", message: "Bye", intent: "done", ended: true, stop_reason: "end_conversation", turn_count: 3 }),
    ]);
    const events: Ev[] = [];
    await runScenario(deps(client, events, ["caller to A1", "answer the screener", "caller to A2"]), job());

    const methods = client.requests.map((r) => r.method);
    // turn(A1 greeting) turn(A1 user) start(S1) fturn(S1) turn(A2 greeting) turn(A2 user)
    expect(methods).toEqual(["turn", "turn", "start", "fturn", "turn", "turn"]);
    const fs = client.requests[2].req.simulation_session_id as string; // flowRunUuid is minted per-run
    expect(fs.endsWith(":fs:S1")).toBe(true); // start keyed on the fs id
    expect(client.requests[3].req).toMatchObject({ node_uuid: "S1", simulation_session_id: fs, user_message: "answer the screener" });
    expect(client.requests[3].req.turn_count).toBe(1); // opener did NOT reset the count to 0
    // after the unit exits, the next call is a stateless turn() on the landing A2
    expect(client.requests[4].method).toBe("turn");
    expect(client.requests[4].req.node_uuid).toBe("A2");
    expect(client.requests[4].req.simulation_session_id).toBeUndefined();
    // session cleaned up on exit
    expect(client.forgotten).toContain(fs);
    expect(client.ended).toContain(fs);

    const turns = events.filter((e) => e.type === "turn_completed").map((e) => e.event_data);
    expect(turns.find((t) => t.agent === "Am I speaking with Sam?")).toMatchObject({ node_uuid: "S1", user: "" }); // opener is its own turn
    expect(events.find((e) => e.type === "scenario_completed")!.event_data.turns).toBe(3);
  });

  test("entry lands on a task unit: first stateless turn switches the loop to flow-session", async () => {
    const client = new FakeClient([
      // entry (node_uuid:"") resolves to the screening node — no turn, just the landing
      resp({ node_uuid: "S1", turn_type: "transition" }),
      // flowSessionStart opener, then exit to A2 then end
      resp({ turn_node_uuid: "S1", node_uuid: "S1", turn_type: "transition", message: "Screening opener", transitions: [{ from_node_uuid: "start", handle: "call", via: [], to_node_uuid: "S1", to_type: "contact_screening" }] }),
      resp({ turn_node_uuid: "S1", node_uuid: "A2", turn_type: "speech", message: "Done screening", intent: "reached", ended: true, stop_reason: "end_conversation", turn_count: 1, transitions: [{ from_node_uuid: "S1", handle: "reached", via: [], to_node_uuid: "A2", to_type: "ai_agent_v2" }] }),
    ]);
    const events: Ev[] = [];
    await runScenario(deps(client, events, ["answer"]), job());

    expect(client.requests.map((r) => r.method)).toEqual(["turn", "start", "fturn"]);
    expect(client.requests[0].req.node_uuid).toBe(""); // entry
    expect(client.requests[1].req.node_uuid).toBe("S1"); // flow-session start on the landing
    // the entry-walk transition is reported by the flow-session start, so nodes_visited keeps Start
    const done = events.find((e) => e.type === "scenario_completed")!.event_data;
    expect(done.nodes_visited).toBe(3); // start + S1 + A2
    expect(done.stop_reason).toBe("end_conversation");
  });
});
