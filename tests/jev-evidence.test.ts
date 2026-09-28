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

test("node and variable questions share one identical state and retain axis routing", () => {
  const plan = buildJevPlan(input([node("A", "Hello.")]));
  const n = plan.axes.find(a => a.judge === "instructions_adherence")!;
  const v = plan.axes.find(a => a.judge === "variable_extraction")!;
  expect(v.requestKey).toBe(n.requestKey);
  for (const axis of plan.axes) {
    const request = plan.requests.find(r => r.key === axis.requestKey)!;
    for (const key of axis.questionKeys) expect(request.questions[key]).toBeDefined();
  }
});
