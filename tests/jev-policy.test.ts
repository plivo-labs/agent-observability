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
