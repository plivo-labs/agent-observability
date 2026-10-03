import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { buildSharedJevPlan } = await import("../src/evals-engine/jev/plan-shared.js");
const { buildJevPlan } = await import("../src/evals-engine/jev/plan.js");
type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;
type NodeEvalInput = import("../src/evals-engine/types.js").NodeEvalInput;
type EvalTurn = import("../src/evals-engine/types.js").EvalTurn;
type CustomJudgeSpec = import("../src/evals-engine/judges/custom-metric.js").CustomJudgeSpec;
type JevPlan = import("../src/evals-engine/jev/plan.js").JevPlan;

const turn = (node: string, over: Partial<EvalTurn>): EvalTurn => ({ node_uuid: node, user: "", agent: "", intent: "", ...over });
const timeline = (node: string): EvalTurn[] => [
  turn(node, { agent: "System_Note: # Role\nYou are an orders agent.\n" + "platform rule line\n".repeat(80), evidence: true }),
  turn(node, { agent: "What is your order id?" }),
  turn(node, { user: "It is 42." }),
  turn(node, { agent: "Tool_Call: record_order_id({\"value\":\"42\"})", evidence: true }),
  turn(node, { agent: "I need your zip code because we only ship locally." }),
  turn(node, { agent: "Tool_Call: handoff_done({})", evidence: true }),
];

const node = (over: Partial<NodeEvalInput> = {}): NodeEvalInput => ({
  node_uuid: "n1",
  node_name: "collect",
  node_prompt: "Collect the order id.",
  available_intents: [{ intent_name: "Done", intent_instructions: "Caller confirmed the order id." }],
  intent_tools: { Done: "handoff_done" },
  chosen_intent: "",
  required_variables: ["order_id"],
  variable_rules: { order_id: "Record the id the caller states." },
  extracted_variables: { order_id: "42" },
  variable_sources: { order_id: { node_uuid: "n1", event_index: 3, status: "succeeded" } },
  turns: timeline("n1"),
  turn_count: 3,
  ...over,
});

const ctx = (over: Partial<ConversationInput> = {}): ConversationInput => ({
  flow_name: "orders",
  global_prompt: "You are an orders agent.",
  nodes: [node()],
  goals: [],
  timeline: timeline("n1"),
  full_transcript: "Agent: What is your order id?\nUser: It is 42.",
  speech_transcript: "Agent: What is your order id?\nUser: It is 42.",
  ...over,
});

const keys = (p: JevPlan) => p.requests.map((r) => r.key).sort();
const text = (q: { instructions: unknown }) => (typeof q.instructions === "string" ? q.instructions : String((q.instructions as { question: string }).question));
const nodeState = (p: JevPlan, k = "s0", n = "n0") => ((p.requests.find((r) => r.key === k)!.state as { nodes: Record<string, Record<string, unknown>> }).nodes[n]!);

describe("buildSharedJevPlan — two requests", () => {
  test("a session sends V1's conversation request unchanged plus one request for every node judge", () => {
    const plan = buildSharedJevPlan(ctx());
    expect(keys(plan)).toEqual(["c", "s0"]);
    const v1 = buildJevPlan(ctx()).requests.find((r) => r.key === "c")!;
    const c = plan.requests.find((r) => r.key === "c")!;
    expect(c.state).toEqual(v1.state);
    expect(c.questions).toEqual(v1.questions);
  });

  test("every axis points at a request that carries all of its questions", () => {
    const plan = buildSharedJevPlan(ctx({ nodes: [node(), node({ node_uuid: "n2", node_name: "confirm" })] }));
    expect(plan.requests.length).toBeLessThanOrEqual(2);
    for (const axis of plan.axes) {
      const request = plan.requests.find((r) => r.key === axis.requestKey)!;
      for (const key of axis.questionKeys) expect(request.questions[key]).toBeDefined();
    }
  });

  test("an oversized multi-node session splits by node and carries the conversation inside the first request", () => {
    const big = (id: string, ch: string) => node({ node_uuid: id, node_name: id, node_prompt: `${ch} `.repeat(20_000), turns: timeline(id) });
    const plan = buildSharedJevPlan(ctx({ nodes: [big("n1", "a"), big("n2", "b"), big("n3", "c")], timeline: [...timeline("n1"), ...timeline("n2"), ...timeline("n3")] }));
    expect(keys(plan)).toEqual(["s0", "s1"]);
    expect(plan.dropped).toHaveLength(0);
    const first = plan.requests.find((r) => r.key === "s0")!;
    const voicemail = first.questions["c.voicemail_detection"]!;
    expect((voicemail.instructions as { call_speech: string }).call_speech).toContain("It is 42.");
    expect(plan.axes.find((a) => a.id === "c.voicemail_detection")!.requestKey).toBe("s0");
    expect(plan.layout).toBe("shared-state-v1/packed");
    for (const axis of plan.axes) {
      const request = plan.requests.find((r) => r.key === axis.requestKey)!;
      for (const key of axis.questionKeys) expect(request.questions[key]).toBeDefined();
    }
  });

  test("a call too long to carry inside a node request keeps V1's conversation request and stays at two", () => {
    const speech = "Agent: Please tell me about your order.\nUser: " + "so the thing is ".repeat(5_000);
    const big = (id: string, ch: string) => node({ node_uuid: id, node_name: id, node_prompt: `${ch} `.repeat(20_000), turns: timeline(id) });
    const plan = buildSharedJevPlan(ctx({ nodes: [big("n1", "a"), big("n2", "b"), big("n3", "c")], timeline: [...timeline("n1"), ...timeline("n2"), ...timeline("n3")],
      full_transcript: speech, speech_transcript: speech }));
    expect(keys(plan)).toEqual(["c", "s0"]);
    expect(plan.requests.find((r) => r.key === "c")!.state).toBe(buildJevPlan(ctx({ full_transcript: speech, speech_transcript: speech })).requests.find((r) => r.key === "c")!.state);
    expect(Object.keys(nodeState(plan, "s0", "n0")).length).toBeGreaterThan(0);
    for (const axis of plan.axes.filter((a) => a.requestKey === "s1")) expect(plan.dropped.map((d) => d.requestKey)).toContain("s1");
  });
});

describe("buildSharedJevPlan — what each judge reads", () => {
  test("the shared state carries no speech transcript and no intent catalog", () => {
    const plan = buildSharedJevPlan(ctx());
    const state = plan.requests.find((r) => r.key === "s0")!.state as Record<string, unknown>;
    expect(Object.keys(state)).toEqual(["agent", "nodes"]);
    expect(JSON.stringify(state)).not.toContain("Caller confirmed the order id.");
    const intent = plan.requests.find((r) => r.key === "s0")!.questions["i0.intent.premature"]!;
    expect(JSON.stringify(intent.instructions)).toContain("Caller confirmed the order id.");
  });

  test("every node question names its node by path", () => {
    const plan = buildSharedJevPlan(ctx());
    const questions = Object.entries(plan.requests.find((r) => r.key === "s0")!.questions);
    expect(questions.length).toBeGreaterThan(5);
    for (const [, q] of questions) expect(text(q)).toContain("`nodes.n0`");
  });

  test("instruction paragraphs that two nodes share are sent once", () => {
    const plan = buildSharedJevPlan(ctx({ nodes: [
      node({ node_prompt: "Shared rules.\n\nCollect the id." }),
      node({ node_uuid: "n2", node_name: "confirm", node_prompt: "Shared rules.\n\nConfirm the id.", turns: timeline("n2") }),
    ] }));
    const state = plan.requests.find((r) => r.key === "s0")!.state as { agent: Record<string, unknown> };
    expect(state.agent.shared_instructions).toBe("Shared rules.");
    expect(nodeState(plan).instructions).toBe("Collect the id.");
    expect(text(plan.requests.find((r) => r.key === "s0")!.questions["a0.objective"]!)).toContain("`agent.shared_instructions`");
  });

  test("a variable write names the node and event, not an internal id", () => {
    const sources = (nodeState(buildSharedJevPlan(ctx())).result as { variable_sources: Record<string, unknown> }).variable_sources;
    expect(sources.order_id).toEqual({ node: "this node (nodes.n0)", event: "e3", status: "succeeded" });
  });

  test("a runtime note keeps only its head", () => {
    const events = String(nodeState(buildSharedJevPlan(ctx())).events);
    expect(events).toContain("[e0] System_Note: # Role");
    expect(events).toContain("…[runtime note clipped]");
    expect(events.split("platform rule line").length).toBeLessThan(20);
  });

  test("a fired intent is asked against its own condition, and that lets Jev decide it", () => {
    const plan = buildSharedJevPlan(ctx());
    const fired = plan.requests.find((r) => r.key === "s0")!.questions["i0.fired.0"]!;
    expect(fired.instructions).toMatchObject({ fired_intent: { name: "Done", condition: "Caller confirmed the order id." }, fired_at: "event e5 of `nodes.n0.events`" });
    const axis = plan.axes.find((a) => a.id === "n0:intent_identification") as { intentFired?: boolean; firedChecked?: boolean; questionKeys: string[] };
    expect(axis.intentFired).toBe(true);
    expect(axis.firedChecked).toBe(true);
    expect(axis.questionKeys).toContain("i0.fired.0");
  });

  test("an intent that fires by name with no tool keeps the fired intent on the LLM", () => {
    const plan = buildSharedJevPlan(ctx({ nodes: [node({
      available_intents: [{ intent_name: "Done", intent_instructions: "Caller confirmed the order id." }, { intent_name: "Transfer", intent_instructions: "Caller asks for a person." }],
      chosen_intent: "Transfer",
    })] }));
    const axis = plan.axes.find((a) => a.id === "n0:intent_identification") as { intentFired?: boolean; firedChecked?: boolean };
    expect(axis.intentFired).toBe(true);
    expect(axis.firedChecked).toBeUndefined();
  });

  test("an agent line that gives a reason is asked about on its own", () => {
    const plan = buildSharedJevPlan(ctx());
    const why = plan.requests.find((r) => r.key === "s0")!.questions["h0.why.0"]!;
    expect((why.instructions as { agent_line: string }).agent_line).toBe("I need your zip code because we only ship locally.");
    expect(plan.axes.find((a) => a.id === "n0:hallucination")!.questionKeys).toContain("h0.why.0");
  });
});

describe("buildSharedJevPlan — switches", () => {
  test("the allow-list keeps a judge off the Jev path entirely", () => {
    const plan = buildSharedJevPlan(ctx(), { judges: ["node_loop", "voicemail_detection"] });
    expect(plan.axes.map((a) => a.id).sort()).toEqual(["c.voicemail_detection", "n0:node_loop"]);
  });

  test("custom metrics ride the shared request, and only when enabled", () => {
    const spec: CustomJudgeSpec = { name: "metric:hold", display_name: "Hold warning", scope: "conversation", body: "Fail if the caller was put on hold without warning.", output: "" };
    expect(buildSharedJevPlan(ctx(), { customSpecs: [spec] }).axes.map((a) => a.id)).not.toContain("m.metric:hold");
    const on = buildSharedJevPlan(ctx(), { customSpecs: [spec], customEnabled: true });
    expect(keys(on)).toEqual(["c", "s0"]);
    expect(on.axes.find((a) => a.id === "m.metric:hold")!.requestKey).toBe("s0");
  });

  test("a node too big for any request is dropped, not sent, and its axes stay in the plan", () => {
    const plan = buildSharedJevPlan(ctx({ nodes: [node({ node_prompt: "P".repeat(400_000) })] }));
    expect(keys(plan)).toEqual(["c"]);
    expect(plan.dropped.map((d) => d.requestKey)).toEqual(["s0"]);
    expect(plan.axes.map((a) => a.id)).toContain("n0:node_loop");
  });
});
