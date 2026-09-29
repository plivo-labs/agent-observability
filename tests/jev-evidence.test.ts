import { expect, test, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";
mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);
const { buildJevPlan } = await import("../src/evals-engine/jev/plan.js");
import type { ConversationInput, NodeEvalInput } from "../src/evals-engine/types.js";

const node = (id: string, speech: string, idle = false): NodeEvalInput => ({
  node_uuid: id, node_name: id, node_prompt: "Ask for the order.", available_intents: [],
  chosen_intent: "", required_variables: ["order"], extracted_variables: {},
  turns: [{ node_uuid: id, user: "", agent: speech, intent: "", idle }], turn_count: 1,
});
const input = (nodes: NodeEvalInput[]): ConversationInput => ({
  flow_name: "orders", global_prompt: "", goals: [], nodes,
  full_transcript: "Agent: Quasar costs 99.\nAgent: Goodbye.",
  timeline: nodes.flatMap(n => n.turns),
});

test("node ownership changes the target evidence even when the whole call is unchanged", () => {
  const a = node("A", "Quasar costs 99.");
  const b = node("B", "Goodbye.");
  const before = buildJevPlan(input([a, b]));
  const after = buildJevPlan(input([{ ...a, turns: b.turns }, { ...b, turns: a.turns }]));
  expect(before.requests.find(r => r.key === "n0")?.state).not.toEqual(after.requests.find(r => r.key === "n0")?.state);
  const h0 = before.requests.find(r => r.key === "h0")!;
  const h1 = before.requests.find(r => r.key === "h1")!;
  expect((h0.state as any).agent_spoken).toEqual(["Agent: Quasar costs 99."]);
  expect((h1.state as any).agent_spoken).toEqual(["Agent: Goodbye."]);
  expect(Object.keys(h0.questions).some(k => k.includes("claim"))).toBe(true);
  expect(Object.keys(h1.questions).some(k => k.includes("claim"))).toBe(false);
});

test("loop evidence excludes idle turns without stripping other judges' evidence", () => {
  const a = node("A", "Still there? [system idle prompt]", true);
  const ctx = { ...input([a]), full_transcript: "Agent: Still there? [system idle prompt]" };
  const plan = buildJevPlan(ctx);
  const loop = plan.axes.find(a => a.judge === "node_loop")!;
  const adherence = plan.axes.find(a => a.judge === "instructions_adherence")!;
  expect(JSON.stringify(plan.requests.find(r => r.key === loop.requestKey)?.state)).not.toContain("Still there?");
  expect(JSON.stringify(plan.requests.find(r => r.key === adherence.requestKey)?.state)).toContain("Still there?");
});

test("node and variable questions share one identical state; adherence gets the same view minus the intent catalog", () => {
  const plan = buildJevPlan(input([node("A", "Hello.")]));
  const n = plan.axes.find(a => a.judge === "node_loop")!;
  const v = plan.axes.find(a => a.judge === "variable_extraction")!;
  const a = plan.axes.find(a => a.judge === "instructions_adherence")!;
  expect(v.requestKey).toBe(n.requestKey);
  expect(a.requestKey).not.toBe(n.requestKey);
  const nodeState = plan.requests.find(r => r.key === n.requestKey)!.state as Record<string, unknown>;
  const adherenceState = plan.requests.find(r => r.key === a.requestKey)!.state as Record<string, unknown>;
  expect(adherenceState.available_intents).toBeUndefined();
  const { available_intents: _routing, ...rest } = nodeState;
  expect(adherenceState).toEqual(rest);
  for (const axis of plan.axes) {
    const request = plan.requests.find(r => r.key === axis.requestKey)!;
    for (const key of axis.questionKeys) expect(request.questions[key]).toBeDefined();
  }
});

test("clipping a tool result retains the next event's owner and revisit order", async () => {
  const { prepareEvidence } = await import("../src/evals-engine/jev/evidence.js");
  const ctx = input([node("A", "Hi"), node("B", "Hello")]);
  ctx.timeline = [
    { node_uuid: "A", user: "", agent: `Tool_Result: lookup -> ${"x".repeat(1700)}`, intent: "", evidence: true },
    { node_uuid: "B", user: "42", agent: "", intent: "" },
    { node_uuid: "A", user: "", agent: "Thanks", intent: "" },
  ];
  const history = prepareEvidence(ctx).conversation;
  expect(history).toContain("[tool output clipped]");
  expect(history).toContain("[event 1; node B]\nUser: 42");
  expect(history.indexOf("[event 2; node A]")).toBeGreaterThan(history.indexOf("[event 1; node B]"));
});
