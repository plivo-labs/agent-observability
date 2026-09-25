import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { buildJevPlan, parseJevJudges, jevNodeState, ALL_JEV_JUDGES } = await import("../src/evals-engine/jev/plan.js");
type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;
type NodeEvalInput = import("../src/evals-engine/types.js").NodeEvalInput;
type CustomJudgeSpec = import("../src/evals-engine/judges/custom-metric.js").CustomJudgeSpec;

const node = (over: Partial<NodeEvalInput> = {}): NodeEvalInput => ({
  node_uuid: "n1",
  node_name: "collect",
  node_prompt: "Collect the order id.",
  available_intents: [{ intent_name: "provide_order", intent_instructions: "caller gives the id" }],
  chosen_intent: "provide_order",
  required_variables: ["order_id"],
  variable_rules: { order_id: "Record the id the caller states." },
  extracted_variables: { order_id: "42" },
  turns: [{ node_uuid: "n1", user: "order 42", agent: "Got it, order 42.", intent: "provide_order" }],
  turn_count: 1,
  ...over,
});

const ctx = (over: Partial<ConversationInput> = {}): ConversationInput => ({
  flow_name: "orders",
  global_prompt: "You are an orders agent.",
  nodes: [node()],
  goals: [],
  full_transcript: "User: order 42\nAgent: Got it, order 42.",
  speech_transcript: "User: order 42\nAgent: Got it, order 42.",
  ...over,
});

const ids = (p: ReturnType<typeof buildJevPlan>) => p.axes.map((a) => a.id).sort();
const keys = (p: ReturnType<typeof buildJevPlan>) => p.requests.map((r) => r.key).sort();

describe("buildJevPlan — request set", () => {
  test("a one-node voice session plans the conversation, node, variable and hallucination requests", () => {
    const plan = buildJevPlan(ctx());
    expect(keys(plan)).toEqual(["c", "h0", "n0", "v0.0"]);
    expect(ids(plan)).toEqual([
      "c.bot_detection", "c.call_screening", "c.do_not_disturb", "c.low_engagement", "c.voicemail_detection", "c.wrong_number",
      "n0:hallucination", "n0:instructions_adherence", "n0:intent_identification", "n0:node_loop", "n0:variable_extraction#0",
    ]);
    const conversation = plan.requests.find((r) => r.key === "c")!;
    expect(Object.keys(conversation.questions)).toHaveLength(6);
    expect(conversation.state).toContain("User: order 42");
  });

  test("question keys are namespaced per request and unique across the plan", () => {
    const plan = buildJevPlan(ctx({ nodes: [node(), node({ node_uuid: "n2", node_name: "confirm" })] }));
    const all = plan.requests.flatMap((r) => Object.keys(r.questions));
    expect(new Set(all).size).toBe(all.length);
    expect(all.some((k) => k.startsWith("n1."))).toBe(true);
    expect(all.some((k) => k.startsWith("h1."))).toBe(true);
  });

  test("every axis points at a request that carries all of its questions", () => {
    const plan = buildJevPlan(ctx());
    for (const axis of plan.axes) {
      const request = plan.requests.find((r) => r.key === axis.requestKey)!;
      expect(request).toBeDefined();
      for (const key of axis.questionKeys) expect(request.questions[key]).toBeDefined();
    }
  });
});

describe("buildJevPlan — what is never asked", () => {
  test("the allow-list can narrow the set to a single judge", () => {
    expect(ids(buildJevPlan(ctx(), { judges: ["low_engagement"] }))).toEqual(["c.low_engagement"]);
  });

  test("a text transport drops the three voice-only detections, keeps the rest", () => {
    const plan = buildJevPlan(ctx({ transport: "chat" }));
    expect(ids(plan)).not.toContain("c.voicemail_detection");
    expect(ids(plan)).not.toContain("c.bot_detection");
    expect(ids(plan)).not.toContain("c.call_screening");
    expect(ids(plan)).toContain("c.low_engagement");
    expect(ids(plan)).toContain("c.wrong_number");
  });

  test("neutral-skip cases are not asked: no intents, no variables, no node prompt", () => {
    const bare = node({ available_intents: [], required_variables: [], variable_rules: {}, extracted_variables: {}, node_prompt: "  " });
    const plan = buildJevPlan(ctx({ nodes: [bare] }));
    expect(ids(plan)).not.toContain("n0:intent_identification");
    expect(ids(plan)).not.toContain("n0:variable_extraction#0");
    expect(ids(plan)).not.toContain("n0:instructions_adherence");
    expect(ids(plan)).toContain("n0:node_loop");
  });

  test("an empty transcript plans nothing at all", () => {
    const plan = buildJevPlan(ctx({ nodes: [], full_transcript: "  ", speech_transcript: "" }));
    expect(plan.requests).toHaveLength(0);
    expect(plan.axes).toHaveLength(0);
  });

  test("a node with no spoken agent line gets no hallucination request", () => {
    const silent = node({ turns: [{ node_uuid: "n1", user: "hello?", agent: "", intent: "" }] });
    const plan = buildJevPlan(ctx({ nodes: [silent], full_transcript: "User: hello?", speech_transcript: "User: hello?" }));
    expect(ids(plan)).not.toContain("n0:hallucination");
  });

  test("the allow-list keeps a judge off the Jev path entirely", () => {
    const plan = buildJevPlan(ctx(), { judges: ["node_loop", "voicemail_detection"] });
    expect(ids(plan)).toEqual(["c.voicemail_detection", "n0:node_loop"]);
  });

  test("custom metrics are only planned when enabled", () => {
    const spec: CustomJudgeSpec = { name: "metric:hold", display_name: "Hold warning", scope: "conversation", body: "Fail if the caller was put on hold without warning.", output: "" };
    expect(ids(buildJevPlan(ctx(), { customSpecs: [spec] }))).not.toContain("m.metric:hold");
    const on = buildJevPlan(ctx(), { customSpecs: [spec], customEnabled: true });
    const axis = on.axes.find((a) => a.id === "m.metric:hold")!;
    expect(axis.kind).toBe("custom");
    expect(on.requests.find((r) => r.key === "m.metric:hold")!.questions[(axis as any).applicableKey]).toBeDefined();
  });

  test("a node-scope custom metric is asked once per node", () => {
    const spec: CustomJudgeSpec = { name: "metric:greeting", display_name: "Greeting", scope: "node", body: "Fail if the agent never greeted.", output: "" };
    const plan = buildJevPlan(ctx({ nodes: [node(), node({ node_uuid: "n2" })] }), { customSpecs: [spec], customEnabled: true });
    expect(ids(plan)).toContain("m0.metric:greeting");
    expect(ids(plan)).toContain("m1.metric:greeting");
  });
});

describe("buildJevPlan — budget", () => {
  const giant = "Tool_Result: lookup -> " + "z".repeat(200_000);
  const transcript = `User: hi\nAgent: hello\n${giant}`;

  test("only tool output is clipped; the transcript and the node prompt reach Jev whole", () => {
    const prompt = "P".repeat(5000);
    const state = jevNodeState(node({ node_prompt: prompt }), ctx({ full_transcript: transcript })) as Record<string, string>;
    expect(state.node_prompt).toBe(prompt);
    expect(state.node_transcript).toBeUndefined();
    expect(state.conversation_history).toContain("User: hi");
    expect(state.conversation_history).toContain("Agent: hello");
    expect(state.conversation_history.length).toBeLessThan(5000);
    expect(state.conversation_history).toContain("[tool output clipped]");
  });

  test("an over-budget request is dropped, not sent, and its axes stay in the plan", () => {
    const plan = buildJevPlan(ctx({ nodes: [node({ node_prompt: "P".repeat(400_000) })] }));
    expect(keys(plan)).not.toContain("n0");
    expect(plan.dropped.map((d) => d.requestKey)).toContain("n0");
    expect(ids(plan)).toContain("n0:node_loop");
  });

  test("a huge tool result alone does not push a session over budget", () => {
    const plan = buildJevPlan(ctx({ full_transcript: transcript, speech_transcript: "User: hi\nAgent: hello" }));
    expect(plan.dropped).toHaveLength(0);
    expect(plan.requests.every((r) => r.estTokens <= 30_000)).toBe(true);
  });
});

describe("parseJevJudges", () => {
  test("'all' and empty mean every judge; a list is filtered and typos are reported", () => {
    expect(parseJevJudges("all").judges).toEqual(ALL_JEV_JUDGES);
    expect(parseJevJudges(undefined).judges).toEqual(parseJevJudges("all").judges);
    const parsed = parseJevJudges("node_loop, halucination ,voicemail_detection");
    expect(parsed.judges).toEqual(["node_loop", "voicemail_detection"]);
    expect(parsed.unknown).toEqual(["halucination"]);
  });
});
