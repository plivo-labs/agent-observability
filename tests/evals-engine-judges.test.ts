import { describe, test, expect, mock } from "bun:test";

// Mock config so importing the llm module (via the judges) doesn't parse real env.
mock.module("../src/config.js", () => ({
  config: {
    LLM_PROVIDER: "anthropic",
    JUDGE_MODEL: undefined,
    SIMULATOR_MODEL: undefined,
    GENERATOR_MODEL: undefined,
    LLM_TIMEOUT_MS: 30000,
    LLM_MAX_RETRIES: 1,
  },
}));

const { MockLLM } = await import("../src/llm/index.js");
const { runHallucinationJudge, runLoopJudge, runVariableExtractionJudge, runInstructionAdherenceJudge } = await import(
  "../src/evals-engine/judges/node-judges.js"
);
const { runIntentJudge } = await import("../src/evals-engine/judges/intent-judge.js");
const { runGoalJudge } = await import("../src/evals-engine/judges/goal-judge.js");
type NodeEvalInput = import("../src/evals-engine/types.js").NodeEvalInput;
type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;

const node = (over: Partial<NodeEvalInput> = {}): NodeEvalInput => ({
  node_uuid: "n1",
  node_name: "collect_order",
  node_prompt: "Ask for the order id and confirm it.",
  available_intents: [{ id: "e1", intent_name: "provide_order" }],
  chosen_intent: "provide_order",
  required_variables: ["order_id"],
  extracted_variables: { order_id: "42" },
  turns: [
    { node_uuid: "n1", user: "my order is 42", agent: "Got it, order 42.", intent: "provide_order" },
  ],
  turn_count: 1,
  ...over,
});

const ctx = (over: Partial<ConversationInput> = {}): ConversationInput => ({
  flow_name: "orders",
  global_prompt: "You are a helpful orders agent.",
  nodes: [node()],
  goals: [],
  full_transcript: "User: my order is 42\nAgent: Got it, order 42.",
  ...over,
});

describe("LLM node judges (MockLLM)", () => {
  test("hallucination: parses raw output; sends criteria+output system and node transcript", async () => {
    const llm = new MockLLM([JSON.stringify({ hallucinated: false, score: 1, reason: "grounded", technical_reason: "t" })]);
    const { data } = await runHallucinationJudge(node(), ctx(), llm);
    expect(data.hallucinated).toBe(false);
    expect(data.score).toBe(1);
    expect(llm.calls[0]!.system).toContain("fabricated information");
    expect(llm.calls[0]!.system).toContain('"hallucinated": boolean');
    // strict json_schema (cx-sqs parity) is passed to the provider
    expect(llm.calls[0]!.jsonSchema?.strict).toBe(true);
    expect(llm.calls[0]!.jsonSchema?.name).toBe("eval_hallucination");
    expect((llm.calls[0]!.jsonSchema?.schema as any).required).toContain("hallucinated");
    expect((llm.calls[0]!.jsonSchema?.schema as any).additionalProperties).toBe(false);
    const sent = JSON.parse(llm.calls[0]!.user);
    expect(sent.node_transcript).toContain("order is 42");
  });

  test("loop: parses raw output", async () => {
    const llm = new MockLLM([JSON.stringify({ loop_detected: false, score: 1, reason: "no loop" })]);
    const { data } = await runLoopJudge(node(), ctx(), llm);
    expect(data.loop_detected).toBe(false);
  });

  test("variable extraction: expected + actual variables land in the system prompt", async () => {
    const llm = new MockLLM([JSON.stringify({ extraction_successful: true, score: 1, reason: "ok" })]);
    const { data } = await runVariableExtractionJudge(node(), ctx(), llm);
    expect(data.extraction_successful).toBe(true);
    expect(llm.calls[0]!.system).toContain("order_id");
    expect(llm.calls[0]!.system).toContain("42");
  });

  test("instruction adherence: returns the 4 sub-metrics", async () => {
    const raw = {
      objective_progress: { achieved: true, score: 1, reason_code: "goal_achieved", reason: "", technical_reason: "" },
      procedure_compliance: { score: 1, reason_code: "", missed_steps: [], reason: "", technical_reason: "" },
      interaction_quality: { score: 0.9, reason_code: "", issues: [], reason: "", technical_reason: "" },
      policy_boundary_compliance: { passed: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
    };
    const llm = new MockLLM([JSON.stringify(raw)]);
    const { data } = await runInstructionAdherenceJudge(node(), ctx(), llm);
    expect(data.objective_progress.achieved).toBe(true);
    expect(data.procedure_compliance.missed_steps).toEqual([]);
  });
});

describe("intent judge (LLM, cx-sqs MetricIntent)", () => {
  test("both flags false → score 1; available intents land in the system prompt", async () => {
    const llm = new MockLLM([JSON.stringify({ intent_not_found: false, intent_wrongly_identified: false, reason: "correct" })]);
    const { data } = await runIntentJudge(node(), ctx(), llm);
    expect(data.score).toBe(1);
    expect(data.intent_wrongly_identified).toBe(false);
    expect(llm.calls[0]!.system).toContain("provide_order");
    expect(llm.calls[0]!.system).toContain('"intent_not_found": boolean');
  });
  test("wrongly identified → score 0", async () => {
    const llm = new MockLLM([JSON.stringify({ intent_not_found: false, intent_wrongly_identified: true, reason: "mismatch" })]);
    const { data } = await runIntentJudge(node(), ctx(), llm);
    expect(data.score).toBe(0);
    expect(data.intent_wrongly_identified).toBe(true);
  });
  test("intent not found → score 0", async () => {
    const llm = new MockLLM([JSON.stringify({ intent_not_found: true, intent_wrongly_identified: false, reason: "not in list" })]);
    const { data } = await runIntentJudge(node(), ctx(), llm);
    expect(data.score).toBe(0);
    expect(data.intent_not_found).toBe(true);
  });
});

describe("goal judge (MockLLM)", () => {
  test("re-attaches flow_goal_id and defaults a goal the model skipped", async () => {
    const goals = [
      { goal_name: "confirm_order", goal_instructions: "confirm the order id", flow_goal_id: 7 },
      { goal_name: "offer_help", goal_instructions: "offer further help", flow_goal_id: 8 },
    ];
    // model returns only the first goal
    const llm = new MockLLM([JSON.stringify({ goals: [{ goal_name: "confirm_order", achieved: true, reason: "did", technical_reason: "" }] })]);
    const { data } = await runGoalJudge(goals, ctx(), llm);
    expect(data.goals).toHaveLength(2);
    expect(data.goals[0]).toMatchObject({ goal_name: "confirm_order", flow_goal_id: 7, achieved: true });
    expect(data.goals[1]).toMatchObject({ goal_name: "offer_help", flow_goal_id: 8, achieved: false, reason: "Goal not evaluated by LLM" });
  });
});

describe("strict json_schema passed by every LLM judge (cx-sqs parity)", () => {
  test("loop, variable, instruction, intent, goal each send a strict schema with the expected name", async () => {
    const mk = (json: string) => new MockLLM([json]);
    const loopLlm = mk(JSON.stringify({ loop_detected: false, score: 1 }));
    const varLlm = mk(JSON.stringify({ extraction_successful: true, score: 1 }));
    const adhLlm = mk(
      JSON.stringify({
        objective_progress: { achieved: true, score: 1 },
        procedure_compliance: { score: 1, missed_steps: [] },
        interaction_quality: { score: 1, issues: [] },
        policy_boundary_compliance: { passed: true, score: 1 },
      }),
    );
    const intentLlm = mk(JSON.stringify({ intent_not_found: false, intent_wrongly_identified: false }));
    const goalLlm = mk(JSON.stringify({ goals: [{ goal_name: "g", achieved: true }] }));

    await runLoopJudge(node(), ctx(), loopLlm);
    await runVariableExtractionJudge(node(), ctx(), varLlm);
    await runInstructionAdherenceJudge(node(), ctx(), adhLlm);
    await runIntentJudge(node(), ctx(), intentLlm);
    await runGoalJudge([{ goal_name: "g", goal_instructions: "do g", flow_goal_id: 1 }], ctx(), goalLlm);

    const check = (llm: { calls: Array<{ jsonSchema?: { name: string; strict?: boolean; schema: unknown } }> }, name: string) => {
      expect(llm.calls[0]!.jsonSchema?.strict).toBe(true);
      expect(llm.calls[0]!.jsonSchema?.name).toBe(name);
      expect((llm.calls[0]!.jsonSchema?.schema as any).additionalProperties).toBe(false);
    };
    check(loopLlm, "eval_loop");
    check(varLlm, "eval_variable");
    check(adhLlm, "eval_instruction");
    check(intentLlm, "eval_intent");
    check(goalLlm, "eval_goal");
  });
});
