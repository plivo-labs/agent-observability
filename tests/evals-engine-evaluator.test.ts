import { describe, test, expect, mock } from "bun:test";
import type { ProviderCompleteArgs } from "../src/llm/types.js";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { MockLLM } = await import("../src/llm/index.js");
const { evaluateSimulation } = await import("../src/evals-engine/index.js");
type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;

// A content-aware responder: routes by the system prompt so parallel judge calls each get valid JSON
// regardless of completion order.
function judgeResponder(over: Record<string, unknown> = {}) {
  return (args: ProviderCompleteArgs): string => {
    const s = args.system;
    if (s.includes("fabricated information")) return JSON.stringify({ hallucinated: false, score: 1, reason: "grounded", technical_reason: "" });
    if (s.includes("Variables expected to be extracted")) return JSON.stringify({ extraction_successful: true, score: 1, reason: "ok", technical_reason: "" });
    if (s.includes("repeat its own previous messages")) return JSON.stringify({ loop_detected: false, score: 1, reason: "no loop", technical_reason: "" });
    if (s.includes("correct intent for the conversation segment")) return JSON.stringify({ intent_not_found: false, intent_wrongly_identified: false, reason: "ok", technical_reason: "" });
    if (s.includes("four-part rubric")) {
      return JSON.stringify({
        objective_progress: { achieved: true, score: 1, reason_code: "goal_achieved", reason: "", technical_reason: "obj" },
        procedure_compliance: { score: 1, reason_code: "", missed_steps: [], reason: "", technical_reason: "proc" },
        interaction_quality: { score: 0.8, reason_code: "", issues: [], reason: "", technical_reason: "" },
        policy_boundary_compliance: { passed: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
        ...over,
      });
    }
    if (s.includes("configured goals were achieved")) return JSON.stringify({ goals: [{ goal_name: "confirm", achieved: true, reason: "did", technical_reason: "" }] });
    return "{}";
  };
}

const baseInput = (over: Partial<ConversationInput> = {}): ConversationInput => ({
  flow_name: "orders",
  global_prompt: "orders agent",
  nodes: [
    {
      node_uuid: "n1",
      node_name: "collect_order",
      node_prompt: "Ask for the order id.",
      available_intents: [{ id: "e1", intent_name: "provide_order" }],
      chosen_intent: "provide_order",
      required_variables: ["order_id"],
      extracted_variables: { order_id: "42" },
      turns: [{ node_uuid: "n1", user: "order 42", agent: "got it", intent: "provide_order" }],
      turn_count: 1,
    },
  ],
  goals: [],
  full_transcript: "User: order 42\nAgent: got it",
  ...over,
});

describe("evaluateSimulation", () => {
  test("produces one node_evaluation with derived adherence + programmatic intent", async () => {
    const llm = new MockLLM([judgeResponder()]);
    const evaluation = await evaluateSimulation(baseInput(), { provider: llm });
    expect(evaluation.node_evaluations).toHaveLength(1);
    const ne = evaluation.node_evaluations[0]!;
    // derived weighted score = .35*1 + .25*1 + .25*0.8 + .15*1 = 0.95
    expect(ne.instructions_adherence.score).toBeCloseTo(0.95, 5);
    expect(ne.instructions_adherence.adherence_passed).toBe(true);
    expect(ne.instructions_adherence.procedure_compliance!.passed).toBe(true);
    expect(ne.intent_identification.score).toBe(1);
    expect(ne.hallucination.hallucinated).toBe(false);
    expect(ne.variable_extraction.extraction_successful).toBe(true);
    // enrichment: required_variables comes from the node config; missing/incorrect default to []
    expect(ne.variable_extraction.required_variables).toEqual(["order_id"]);
    expect(ne.variable_extraction.missing_variables).toEqual([]);
    expect(ne.variable_extraction.incorrect_variables).toEqual([]);
    expect(ne.node_loop.loop_detected).toBe(false);
  });

  test("adherence_passed=false + procedure fails on a critical missed step", async () => {
    const llm = new MockLLM([
      judgeResponder({
        objective_progress: { achieved: false, score: 0, reason_code: "abandoned_goal", reason: "", technical_reason: "" },
        procedure_compliance: { score: 0.2, reason_code: "critical_step_missed", missed_steps: [{ step: "confirm", severity: "critical", reason_code: "", details: "" }], reason: "", technical_reason: "" },
      }),
    ]);
    const evaluation = await evaluateSimulation(baseInput(), { provider: llm });
    const adh = evaluation.node_evaluations[0]!.instructions_adherence;
    expect(adh.procedure_compliance!.passed).toBe(false);
    expect(adh.adherence_passed).toBe(false);
  });

  test("goal_evaluation omitted when no goals; present + gated when goals exist", async () => {
    const noGoals = await evaluateSimulation(baseInput(), { provider: new MockLLM([judgeResponder()]) });
    expect(noGoals.goal_evaluation).toBeUndefined();

    const withGoals = await evaluateSimulation(
      baseInput({ goals: [{ goal_name: "confirm", goal_instructions: "confirm the order", flow_goal_id: 3 }] }),
      { provider: new MockLLM([judgeResponder()]) },
    );
    expect(withGoals.goal_evaluation!.goals[0]).toMatchObject({ goal_name: "confirm", flow_goal_id: 3, achieved: true });
  });

  test("a judge that never returns valid JSON rejects the whole eval (→ eval_error upstream)", async () => {
    const bad = new MockLLM([
      (args: ProviderCompleteArgs) => (args.system.includes("fabricated information") ? "not json" : judgeResponder()(args)),
    ]);
    await expect(evaluateSimulation(baseInput(), { provider: bad })).rejects.toThrow();
  });
});

describe("goal-judge leniency by simulation_mode", () => {
  const withGoals = () => baseInput({ goals: [{ goal_name: "confirm", goal_instructions: "confirm the order", flow_goal_id: 3 }] });
  const goalCallSystem = (llm: InstanceType<typeof MockLLM>) => llm.calls.find((c) => c.system.includes("configured goals were achieved"))!.system;

  test("stress → strict goal judge (no SIMULATION CONTEXT block)", async () => {
    const llm = new MockLLM([judgeResponder()]);
    await evaluateSimulation(withGoals(), { provider: llm, simulationMode: "stress" });
    expect(goalCallSystem(llm)).not.toContain("SIMULATION CONTEXT");
  });

  test("smoke → lenient goal judge (SIMULATION CONTEXT block present)", async () => {
    const llm = new MockLLM([judgeResponder()]);
    await evaluateSimulation(withGoals(), { provider: llm, simulationMode: "smoke" });
    expect(goalCallSystem(llm)).toContain("SIMULATION CONTEXT");
  });

  test("missing mode → lenient (preserves today's behaviour)", async () => {
    const llm = new MockLLM([judgeResponder()]);
    await evaluateSimulation(withGoals(), { provider: llm });
    expect(goalCallSystem(llm)).toContain("SIMULATION CONTEXT");
  });
});
