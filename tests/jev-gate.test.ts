import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { buildJevPlan } = await import("../src/evals-engine/jev/plan.js");
const { gatePlan, byAxisId } = await import("../src/evals-engine/jev/gate.js");
const { DEFAULT_GATES } = await import("../src/jev/gates.js");
const { JevError, JEV_OVERFLOW } = await import("../src/jev/types.js");
type JevResponse = import("../src/jev/types.js").JevResponse;
type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;
type NodeEvalInput = import("../src/evals-engine/types.js").NodeEvalInput;
type JevPlan = import("../src/evals-engine/jev/plan.js").JevPlan;

const node = (over: Partial<NodeEvalInput> = {}): NodeEvalInput => ({
  node_uuid: "n1", node_name: "collect", node_prompt: "Collect the order id.",
  available_intents: [{ intent_name: "provide_order", intent_instructions: "caller gives the id" }, { intent_name: "opt_out", intent_instructions: "caller opts out" }],
  chosen_intent: "provide_order", required_variables: ["order_id", "callback"],
  variable_rules: { order_id: "Record the id.", callback: "Record a callback time." },
  extracted_variables: { order_id: "42" },
  turns: [{ node_uuid: "n1", user: "order 42", agent: "Got it, order 42.", intent: "provide_order" }], turn_count: 1,
  ...over,
});
const ctx = (over: Partial<ConversationInput> = {}): ConversationInput => ({
  flow_name: "orders", global_prompt: "You are an orders agent.", nodes: [node()], goals: [],
  full_transcript: "User: order 42\nAgent: Got it, order 42.", speech_transcript: "User: order 42\nAgent: Got it, order 42.",
  ...over,
});

/** Respond to every question of every request with `p`, overridden per key. */
function respond(plan: JevPlan, p: number, overrides: Record<string, number> = {}): Map<string, { ok: true; response: JevResponse }> {
  const out = new Map<string, { ok: true; response: JevResponse }>();
  for (const request of plan.requests) {
    const answers: JevResponse["answers"] = {};
    for (const key of Object.keys(request.questions)) answers[key] = { type: "noul", noul: overrides[key] ?? p };
    out.set(request.key, { ok: true, response: { model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 }, answers } });
  }
  return out;
}

describe("gatePlan", () => {
  test("low probabilities auto-pass, high ones auto-fail, the middle is reviewed", () => {
    const plan = buildJevPlan(ctx());
    const low = byAxisId(gatePlan(plan, respond(plan, 0.02), DEFAULT_GATES));
    expect(low.get("c.voicemail_detection")!.outcome).toBe("pass");
    expect(low.get("n0:node_loop")!.outcome).toBe("pass");
    expect(low.get("n0:node_loop")!.p).toBe(0.02);
    expect(low.get("n0:node_loop")!.jevModel).toBe("jev-1.13.0");

    const high = byAxisId(gatePlan(plan, respond(plan, 0.95), DEFAULT_GATES));
    expect(high.get("c.voicemail_detection")!.outcome).toBe("fail");
    expect(high.get("n0:variable_extraction")!.outcome).toBe("fail");

    const mid = byAxisId(gatePlan(plan, respond(plan, 0.5), DEFAULT_GATES));
    expect(mid.get("n0:node_loop")!.outcome).toBe("review");
    expect(mid.get("n0:node_loop")!.fallback).toBeUndefined();
  });

  test("hallucination never auto-fails and adherence never auto-passes", () => {
    const plan = buildJevPlan(ctx());
    const high = byAxisId(gatePlan(plan, respond(plan, 0.99), DEFAULT_GATES));
    expect(high.get("n0:hallucination")!.outcome).toBe("review");
    expect(high.get("n0:instructions_adherence")!.outcome).toBe("fail");
    const low = byAxisId(gatePlan(plan, respond(plan, 0.01), DEFAULT_GATES));
    expect(low.get("n0:hallucination")!.outcome).toBe("pass");
    expect(low.get("n0:instructions_adherence")!.outcome).toBe("review");
  });

  test("an axis takes the highest of its questions, and fired keys are the ones at or above the threshold", () => {
    const plan = buildJevPlan(ctx());
    const vars = plan.axes.find((a) => a.id === "n0:variable_extraction")!;
    const [first, second] = vars.questionKeys;
    const gated = byAxisId(gatePlan(plan, respond(plan, 0.05, { [second!]: 0.97 }), DEFAULT_GATES));
    const axis = gated.get("n0:variable_extraction")!;
    expect(axis.outcome).toBe("fail");
    expect(axis.p).toBe(0.97);
    expect(axis.firedKeys).toEqual([second!]);
    expect(axis.probabilities[first!]).toBe(0.05);
  });

  test("a dropped request, a transport error and an overflow all review with a named fallback", () => {
    const plan = buildJevPlan(ctx());
    const results = respond(plan, 0.02);
    results.delete("n0");
    const withError = new Map<string, any>(results);
    withError.set("n0", { ok: false, error: new JevError(500, "server_error") });
    withError.set("v0", { ok: false, error: new JevError(400, JEV_OVERFLOW) });
    const gated = byAxisId(gatePlan(plan, withError, DEFAULT_GATES));
    expect(gated.get("n0:node_loop")!.outcome).toBe("review");
    expect(gated.get("n0:node_loop")!.fallback).toBe("error");
    expect(gated.get("n0:variable_extraction")!.fallback).toBe("overflow");

    const budgetPlan = buildJevPlan(ctx({ nodes: [node({ node_prompt: "P".repeat(400_000) })] }));
    const budgetGated = byAxisId(gatePlan(budgetPlan, respond(budgetPlan, 0.02), DEFAULT_GATES));
    expect(budgetGated.get("n0:node_loop")!.fallback).toBe("budget");
  });

  test("a missing answer is reviewed, never read as a probability", () => {
    const plan = buildJevPlan(ctx());
    const empty = new Map(
      plan.requests.map((r) => [r.key, { ok: true as const, response: { model: "m", usage: { input_tokens: 1, output_tokens: 0 }, answers: {} } }]),
    );
    const gated = byAxisId(gatePlan(plan, empty, DEFAULT_GATES));
    expect(gated.get("n0:node_loop")!.outcome).toBe("review");
    expect(gated.get("n0:node_loop")!.fallback).toBe("unanswered");
    expect(gated.get("n0:node_loop")!.p).toBeNull();
  });

  test("a custom metric that never applied is 'unknown' and costs no review", () => {
    const spec = { name: "metric:hold", display_name: "Hold", scope: "conversation" as const, body: "Fail if held without warning.", output: "" };
    const plan = buildJevPlan(ctx(), { customSpecs: [spec], customEnabled: true });
    const axis = plan.axes.find((a) => a.id === "m.metric:hold")! as any;
    const gated = byAxisId(gatePlan(plan, respond(plan, 0.9, { [axis.applicableKey]: 0.03 }), DEFAULT_GATES));
    expect(gated.get("m.metric:hold")!.outcome).toBe("unknown");

    const applies = byAxisId(gatePlan(plan, respond(plan, 0.9, { [axis.applicableKey]: 0.98 }), DEFAULT_GATES));
    expect(applies.get("m.metric:hold")!.outcome).toBe("fail");
  });
});
