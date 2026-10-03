import { expect, mock, test } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";
mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);
const { buildJevPlan } = await import("../src/evals-engine/jev/plan.js");
const { gatePlan, mergeChunkedAxes } = await import("../src/evals-engine/jev/gate.js");
const { DEFAULT_GATES } = await import("../src/jev/gates.js");
import type { ConversationInput } from "../src/evals-engine/types.js";
import type { RequestResult } from "../src/evals-engine/jev/gate.js";

const input: ConversationInput = {
  flow_name: "orders", global_prompt: "", goals: [], full_transcript: "User: 42\nAgent: Thank you.",
  nodes: [{ node_uuid: "a", node_name: "orders", node_prompt: "Collect the order ID.",
    available_intents: [], chosen_intent: "", required_variables: ["workflow_status", "order_id"],
    variable_rules: { workflow_status: "Record the backend lookup result.", order_id: "Record the caller's order ID." },
    extracted_variables: {}, turns: [{ node_uuid: "a", user: "42", agent: "Thank you.", intent: "" }], turn_count: 1 }],
};

for (const orderProbability of [undefined, 0.5, 0.02]) {
  test(`excluding a platform field preserves the remaining variable decision (${orderProbability})`, () => {
    const plan = buildJevPlan(input, { judges: ["variable_extraction"] });
    const results = new Map<string, RequestResult>();
    for (const request of plan.requests) {
      const answers = Object.fromEntries(Object.keys(request.questions).flatMap((key) => {
        const p = key.endsWith("var.0") ? 0.96 : orderProbability;
        return p === undefined ? [] : [[key, { type: "noul" as const, noul: p }]];
      }));
      results.set(request.key, { ok: true, response: { model: "test", usage: { input_tokens: 0, output_tokens: 0 }, answers } });
    }
    const [decision] = mergeChunkedAxes(gatePlan(plan, results, DEFAULT_GATES, input.nodes));
    expect(decision!.outcome).toBe(orderProbability === 0.02 ? "pass" : "review");
  });
}

test("uncertain applicability cannot establish a custom-metric pass", () => {
  const spec = { name: "metric:hold", display_name: "Hold", scope: "conversation" as const, body: "Fail if hold is unannounced.", output: "" };
  const plan = buildJevPlan(input, { judges: [], customEnabled: true, customSpecs: [spec] });
  const results = new Map<string, RequestResult>(plan.requests.map((request) => [request.key, { ok: true, response: {
    model: "test", usage: { input_tokens: 0, output_tokens: 0 },
    answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul" as const, noul: key.endsWith("applicable") ? 0.21 : 0.01 }])),
  } }]));
  expect(gatePlan(plan, results, DEFAULT_GATES)[0]!.outcome).toBe("review");
});

test("only unchanged conversation passes bypass review; failures and new evidence never do", async () => {
  const { routeAxis } = await import("../src/evals-engine/jev/policy.js");
  const c = { axis: { kind: "conversation", judge: "bot_detection" }, outcome: "pass", p: 0.01, probabilities: {}, firedKeys: [] } as any;
  expect(routeAxis(c)).toBe("auto_pass");
  expect(routeAxis({ ...c, outcome: "fail" })).toBe("verify_failure");
  expect(routeAxis({ ...c, outcome: "review" })).toBe("uncertain_or_incomplete");
  expect(routeAxis({ ...c, axis: { kind: "node" } })).toBe("uncalibrated_evidence");
  expect(routeAxis({ ...c, axis: { kind: "custom" }, outcome: "unknown" })).toBe("verify_applicability");
});


for (const probability of [undefined, 0.5, 0.02]) {
  test(`a pending final batch cannot clear an unresolved immediate field (${probability})`, () => {
    const node = { ...input.nodes[0]!, node_prompt: "Submit lead data before any transfer.",
      required_variables: ["order_id", "callback"],
      variable_rules: { order_id: "Record the caller's order ID.", callback: "Record immediately when the caller states a callback time." },
      turns: [
        { node_uuid: "a", user: "Order 42. Call back tomorrow.", agent: "", intent: "" },
        { node_uuid: "a", user: "", agent: "Let me transfer you now [interrupted]", intent: "" },
        { node_uuid: "a", user: "Okay", agent: "", intent: "" },
      ],
    };
    const plan = buildJevPlan({ ...input, nodes: [node] }, { judges: ["variable_extraction"] });
    const results = new Map<string, RequestResult>(plan.requests.map(r => [r.key, { ok: true, response: {
      model: "test", usage: { input_tokens: 0, output_tokens: 0 },
      answers: Object.fromEntries(Object.keys(r.questions).flatMap(k => {
        const p = k.endsWith("var.0") ? 0.96 : probability;
        return p === undefined ? [] : [[k, { type: "noul" as const, noul: p }]];
      })),
    } }]));
    const [g] = mergeChunkedAxes(gatePlan(plan, results, DEFAULT_GATES, [node]));
    expect(g!.ignoredKeys).toHaveLength(1);
    expect(g!.outcome).toBe(probability === 0.02 ? "pass" : "review");
  });
}

test("named judges publish their confident outcomes; custom metrics and unnamed judges never do", async () => {
  const { routeAxis, parseJudgeList, AUTO_FAIL_JUDGES, AUTO_PASS_JUDGES } = await import("../src/evals-engine/jev/policy.js");
  const policy = { nodeAutoPass: new Set(["node_loop"]), autoFail: new Set(["node_loop", "bot_detection"]) };
  const node = { axis: { kind: "node", judge: "node_loop" }, outcome: "pass", p: 0.01, probabilities: {}, firedKeys: [] } as any;
  expect(routeAxis(node, policy)).toBe("auto_pass");
  expect(routeAxis({ ...node, outcome: "fail" }, policy)).toBe("auto_fail");
  expect(routeAxis({ ...node, outcome: "review" }, policy)).toBe("uncertain_or_incomplete");
  expect(routeAxis({ ...node, axis: { kind: "node", judge: "hallucination" } }, policy)).toBe("uncalibrated_evidence");
  expect(routeAxis({ ...node, axis: { kind: "node", judge: "hallucination" }, outcome: "fail" }, policy)).toBe("verify_failure");
  expect(routeAxis({ ...node, axis: { kind: "conversation", judge: "bot_detection" }, outcome: "fail" }, policy)).toBe("auto_fail");
  expect(routeAxis({ ...node, axis: { kind: "custom", judge: "node_loop" }, outcome: "fail" }, policy)).toBe("verify_failure");

  expect([...parseJudgeList("all", AUTO_PASS_JUDGES).judges]).toEqual([...AUTO_PASS_JUDGES]);
  expect(parseJudgeList("off", AUTO_FAIL_JUDGES).judges.size).toBe(0);
  const typo = parseJudgeList("node_loop, node_lop", AUTO_PASS_JUDGES);
  expect([...typo.judges]).toEqual(["node_loop"]);
  expect(typo.unknown).toEqual(["node_lop"]);
});

test("an intent pass goes to the LLM when an intent fired in the node", async () => {
  const { routeAxis } = await import("../src/evals-engine/jev/policy.js");
  const policy = { nodeAutoPass: new Set(["intent_identification"]), autoFail: new Set<string>() };
  const quiet = { axis: { kind: "node", judge: "intent_identification" }, outcome: "pass", p: 0.05, probabilities: {}, firedKeys: [] } as any;
  expect(routeAxis(quiet, policy)).toBe("auto_pass");
  expect(routeAxis({ ...quiet, axis: { ...quiet.axis, intentFired: true } }, policy)).toBe("uncalibrated_evidence");

  const withIntent = (chosen: string, toolLine: string) => buildJevPlan({
    ...input, full_transcript: `User: yes\n${toolLine}`,
    nodes: [{ ...input.nodes[0]!, available_intents: [{ intent_name: "Done", intent_instructions: "Caller confirmed." }],
      intent_tools: { Done: "handoff_done" }, chosen_intent: chosen,
      turns: [{ node_uuid: "a", user: "yes", agent: toolLine, intent: "" }] }],
  }).axes.find((a) => a.judge === "intent_identification") as any;
  expect(withIntent("", "Agent: Thanks.").intentFired).toBeUndefined();
  expect(withIntent("Done", "Agent: Thanks.").intentFired).toBe(true);
});

test("verdicts from the per-view layout carry no layout tag", async () => {
  const { decisionProvenance } = await import("../src/evals-engine/jev/policy.js");
  const g = { axis: { kind: "node", judge: "node_loop", questionKeys: [] }, outcome: "pass", p: 0.05, probabilities: {}, firedKeys: [] } as any;
  expect(decisionProvenance(g).jev).not.toHaveProperty("layout");
  expect(decisionProvenance(g, undefined, undefined, "shared-state-v1").jev?.layout).toBe("shared-state-v1");
});

test("a fired intent asked against its own condition may be decided by Jev", async () => {
  const { routeAxis } = await import("../src/evals-engine/jev/policy.js");
  const policy = { nodeAutoPass: new Set(["intent_identification"]), autoFail: new Set<string>() };
  const fired = { axis: { kind: "node", judge: "intent_identification", intentFired: true, firedChecked: true }, outcome: "pass", p: 0.05, probabilities: {}, firedKeys: [] } as any;
  expect(routeAxis(fired, policy)).toBe("auto_pass");
});
