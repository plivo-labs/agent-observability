import { describe, test, expect, spyOn, mock, beforeEach, afterAll } from "bun:test";
import { type SimResponse, LiveKitSimError } from "../src/sim-engine/run-engine/livekit-client.js";
import * as dbMod from "../src/sim-engine/db.js";
import * as adapterMod from "../src/evals-engine/integration/sim-adapter.js";
import { MockLLM } from "../src/llm/index.js";
import { runScenario } from "../src/sim-engine/run-engine/orchestrator.js";

// The orchestrator turn loop against a scripted agent-runner client + user-simulator. Covers
// transcript attribution on turn_node_uuid, the next_speaker-driven greeting rule, judges skipped
// at zero turns, the max_turns pre-check (no wasted user-simulator call at the cap), a run_lost
// (410) error row with end() called, and stop_detail → the `error` column only on abort reasons.
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
  requests: Array<{ req: any }> = [];
  ended: string[] = [];
  private i = 0;
  constructor(private script: Array<SimResponse | Error>) {}
  private next(): SimResponse {
    const r = this.script[this.i++];
    if (r === undefined) throw new Error(`FakeClient: no scripted response for call #${this.i}`);
    if (r instanceof Error) throw r;
    return r;
  }
  async turn(req: any) { this.requests.push({ req }); return this.next(); }
  async end(id: string) { this.ended.push(id); }
}

const resp = (over: Partial<SimResponse>): SimResponse => ({
  message: "", intent: "", variables: {}, tool_calls: [], response_items: [],
  turn_node_uuid: "", node_uuid: "", node_run_uuid: "nr", turn_count: 0, turn_type: "speech",
  transitions: [], ended: false, stop_reason: "", stop_detail: "", variables_by_node: {}, next_speaker: "caller",
  ...over,
});

const FLOW = JSON.stringify({
  nodes: [
    { id: "A1", type: "ai_agent_v2", data: { config: { name: "A1" } } },
    { id: "A2", type: "ai_agent_v2", data: { config: { name: "A2" } } },
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

/** Like `deps`, but the user-simulator returns full decision objects (message + target_achieved
 *  + end_call) so the caller-hangup branches can be exercised. */
function decisionDeps(client: FakeClient, events: Ev[], decisions: Array<Record<string, unknown>>) {
  return {
    redis: fakeRedis(events),
    livekit: client as any,
    rng: () => 0.5,
    llmProvider: new MockLLM(decisions.map((d) => JSON.stringify(d))),
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
      // entry greeting on A1 (pendingGreeting starts true → empty caller line)
      resp({ turn_node_uuid: "A1", node_uuid: "A1", turn_type: "transition", message: "Hello from A1", next_speaker: "caller", transitions: [{ from_node_uuid: "start", handle: "call", via: [], to_node_uuid: "A1", to_type: "ai_agent_v2" }] }),
      // A1 fires an intent, the walk lands on A2, and A2 speaks next
      resp({ turn_node_uuid: "A1", node_uuid: "A2", turn_type: "speech", message: "Transferring you", intent: "go_a2", turn_count: 1, next_speaker: "agent", transitions: [{ from_node_uuid: "A1", handle: "go_a2", via: [], to_node_uuid: "A2", to_type: "ai_agent_v2" }] }),
      // A2 greeting (next_speaker was "agent" → empty caller line)
      resp({ turn_node_uuid: "A2", node_uuid: "A2", turn_type: "transition", message: "Hi, A2 here", turn_count: 1, next_speaker: "caller" }),
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
    // node-switch greeting: A2 speaks first, empty caller line (next_speaker drove it)
    expect(turns[2]).toMatchObject({ node_uuid: "A2", user: "", agent: "Hi, A2 here" });
    expect(turns[3]).toMatchObject({ node_uuid: "A2", user: "caller to A2", agent: "Goodbye", intent: "done" });

    // greetings are unprompted: the caller lines land on turns #2 and #4, the greetings on #1/#3.
    expect(client.requests.map((r) => r.req.user_message)).toEqual(["", "caller to A1", "", "caller to A2"]);

    const done = events.find((e) => e.type === "scenario_completed")!.event_data;
    expect(done.turns).toBe(2);
    expect(evalCalls).toBe(1);
    expect(completeCalls[0].error).toBeNull();
  });

  test("abort reason writes stop_detail into the error column (status stays completed)", async () => {
    const detail = 'no edge for intent "weird" at "A1"';
    const client = new FakeClient([
      resp({ turn_node_uuid: "A1", node_uuid: "A1", turn_type: "transition", message: "Hello", next_speaker: "caller", transitions: [{ from_node_uuid: "start", handle: "call", via: [], to_node_uuid: "A1", to_type: "ai_agent_v2" }] }),
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

  test("max_turns pre-check: no user-simulator call spent once turn_count hits the cap", async () => {
    const client = new FakeClient([
      // greeting (turn_count 0), then one real caller turn that reaches the cap (turn_count 1)
      resp({ turn_node_uuid: "A1", node_uuid: "A1", turn_type: "transition", message: "Hi", next_speaker: "caller" }),
      resp({ turn_node_uuid: "A1", node_uuid: "A1", turn_type: "speech", message: "reply", intent: "chat", turn_count: 1, next_speaker: "caller" }),
    ]);
    const events: Ev[] = [];
    // exactly ONE caller line: a second user-simulator call would exhaust the MockLLM and throw,
    // so the run finishing on max_turns proves the pre-check fired before a wasted call.
    await runScenario(deps(client, events, ["only line"]), job({ maxTurns: 1 }));

    expect(client.requests.map((r) => r.req.user_message)).toEqual(["", "only line"]);
    const done = events.find((e) => e.type === "scenario_completed")!.event_data;
    expect(done.stop_reason).toBe("max_turns");
    expect(completeCalls[0].status).toBe("completed");
    expect(completeCalls[0].error).toBeNull();
  });

  test("run_lost (410) mid-run: error row with stop_detail run_lost + end() called", async () => {
    const client = new FakeClient([
      resp({ turn_node_uuid: "A1", node_uuid: "A1", turn_type: "transition", message: "Hi from A1", next_speaker: "caller" }),
      new LiveKitSimError("livekit sim /v1/simulation/turn returned status 410: run_lost", 410, true),
    ]);
    const events: Ev[] = [];
    await runScenario(deps(client, events, ["hi there"]), job());

    const started = events.find((e) => e.type === "scenario_started")!.event_data;
    const done = events.find((e) => e.type === "scenario_completed")!.event_data;
    expect(done.stop_reason).toBe("error");
    expect(done.stop_detail).toBe("run_lost");
    // best-effort teardown fired with the scenario's flow_run_uuid
    expect(client.ended).toEqual([started.flow_run_uuid]);
    expect(completeCalls[0].status).toBe("error");
  });
});

describe("caller-decision loop exit", () => {
  const greetThenAsk = () =>
    new FakeClient([
      resp({ turn_node_uuid: "A1", node_uuid: "A1", turn_type: "transition", message: "Hi from A1", next_speaker: "caller" }),
      resp({ turn_node_uuid: "A1", node_uuid: "A1", turn_type: "speech", message: "Anything else?", intent: "chat", turn_count: 1, next_speaker: "caller" }),
    ]);

  test("end_call without target_achieved → caller_hung_up, closing line sent, end() called", async () => {
    const client = greetThenAsk();
    const events: Ev[] = [];
    await runScenario(decisionDeps(client, events, [{ message: "no, bye", target_achieved: false, end_call: true }]), job());

    const started = events.find((e) => e.type === "scenario_started")!.event_data;
    const done = events.find((e) => e.type === "scenario_completed")!.event_data;
    expect(done.stop_reason).toBe("caller_hung_up");
    // the caller's closing line still reached agent-runner (transcript keeps it + any goodbye)
    expect(client.requests.map((r) => r.req.user_message)).toEqual(["", "no, bye"]);
    // the held run is released best-effort
    expect(client.ended).toEqual([started.flow_run_uuid]);
    // not an abort → error null so the row counts toward passed/failed
    expect(completeCalls[0].error).toBeNull();
    expect(completeCalls[0].stopReason).toBe("caller_hung_up");
  });

  test("end_call with target_achieved → caller_goal_met", async () => {
    const client = greetThenAsk();
    const events: Ev[] = [];
    await runScenario(decisionDeps(client, events, [{ message: "great, thanks. bye", target_achieved: true, end_call: true }]), job());
    const done = events.find((e) => e.type === "scenario_completed")!.event_data;
    expect(done.stop_reason).toBe("caller_goal_met");
  });

  test("agent-runner terminal wins over a same-turn caller end_call", async () => {
    const client = new FakeClient([
      resp({ turn_node_uuid: "A1", node_uuid: "A1", turn_type: "transition", message: "Hi", next_speaker: "caller" }),
      resp({ turn_node_uuid: "A1", node_uuid: "A1", turn_type: "speech", message: "Goodbye", intent: "done", ended: true, stop_reason: "end_conversation", turn_count: 1 }),
    ]);
    const events: Ev[] = [];
    await runScenario(decisionDeps(client, events, [{ message: "ok bye", target_achieved: true, end_call: true }]), job());
    const done = events.find((e) => e.type === "scenario_completed")!.event_data;
    expect(done.stop_reason).toBe("end_conversation"); // agent terminal, not caller_goal_met
    expect(client.ended).toEqual([]); // caller did not end → no best-effort end()
  });
});

describe("whole-run route assertion", () => {
  const routeJob = (ero: Record<string, unknown>) => job({ scenario: { ...SCENARIO, eval_metadata: { expected_route_outcome: ero } } });

  // greeting on A1, then A1 fires `intent` and the walk lands on `to`, ending the run.
  const routeClient = (intent: string, to: string | null) =>
    new FakeClient([
      resp({ turn_node_uuid: "A1", node_uuid: "A1", turn_type: "transition", message: "Hi from A1", next_speaker: "caller", transitions: [{ from_node_uuid: "start", handle: "call", via: [], to_node_uuid: "A1", to_type: "ai_agent_v2" }] }),
      resp({ turn_node_uuid: "A1", node_uuid: to ?? "A1", turn_type: "speech", message: "Routing", intent, turn_count: 1, ended: true, stop_reason: "end_conversation", transitions: [{ from_node_uuid: "A1", handle: intent, via: [], to_node_uuid: to, to_type: "ai_agent_v2" }] }),
    ]);

  test("match → no override; transitions ride the turn payload", async () => {
    const client = routeClient("go_a2", "A2");
    const events: Ev[] = [];
    await runScenario(deps(client, events, ["caller line"]), routeJob({ source_node_id: "A1", expected_intent_name: "go_a2", target_node_id: "A2" }));
    const done = events.find((e) => e.type === "scenario_completed")!.event_data;
    expect(done.stop_reason).toBe("end_conversation");
    const turns = events.filter((e) => e.type === "turn_completed").map((e) => e.event_data);
    expect(turns.some((t) => Array.isArray(t.transitions) && t.transitions.some((tr: any) => tr.to_node_uuid === "A2"))).toBe(true);
  });

  test("wrong intent → route_mismatch (counts failed, describes what was taken)", async () => {
    const client = routeClient("other", "A2");
    const events: Ev[] = [];
    await runScenario(deps(client, events, ["caller line"]), routeJob({ source_node_id: "A1", expected_intent_name: "go_a2", target_node_id: "A2" }));
    const done = events.find((e) => e.type === "scenario_completed")!.event_data;
    expect(done.stop_reason).toBe("route_mismatch");
    expect(done.stop_detail).toContain("expected A1:go_a2 → A2");
    expect(done.stop_detail).toContain("other → A2");
    expect(completeCalls[0].error).toBeNull();
    expect(completeCalls[0].stopReason).toBe("route_mismatch");
  });

  test("expected target reached as a mocked via hop counts as a match", async () => {
    const client = new FakeClient([
      resp({ turn_node_uuid: "A1", node_uuid: "A1", turn_type: "transition", message: "Hi from A1", next_speaker: "caller" }),
      resp({
        turn_node_uuid: "A1", node_uuid: "END", turn_type: "speech", message: "", intent: "go_http", turn_count: 1,
        ended: true, stop_reason: "end_conversation", next_speaker: "caller",
        transitions: [{ from_node_uuid: "A1", handle: "h", via: [{ node_uuid: "HTTP", type: "http_request", outcome: "success" }], to_node_uuid: "END", to_type: "end_conversation" }],
      }),
    ]);
    const events: Ev[] = [];
    await runScenario(deps(client, events, ["caller line"]), routeJob({ source_node_id: "A1", expected_intent_name: "go_http", target_node_id: "HTTP" }));
    const done = events.find((e) => e.type === "scenario_completed")!.event_data;
    expect(done.stop_reason).toBe("end_conversation");
  });

  test("source never reached → route_mismatch with 'never reached'", async () => {
    const client = routeClient("go_a2", "A2");
    const events: Ev[] = [];
    await runScenario(deps(client, events, ["caller line"]), routeJob({ source_node_id: "ZZZ", expected_intent_name: "go_a2", target_node_id: "A2" }));
    const done = events.find((e) => e.type === "scenario_completed")!.event_data;
    expect(done.stop_reason).toBe("route_mismatch");
    expect(done.stop_detail).toContain("never reached");
  });

  test("incomplete expected route (empty target) → assertion skipped", async () => {
    const client = routeClient("other", "A2");
    const events: Ev[] = [];
    await runScenario(deps(client, events, ["caller line"]), routeJob({ source_node_id: "A1", expected_intent_name: "go_a2", target_node_id: "" }));
    const done = events.find((e) => e.type === "scenario_completed")!.event_data;
    expect(done.stop_reason).toBe("end_conversation"); // no override — expected route incomplete
  });
});
