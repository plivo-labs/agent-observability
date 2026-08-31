import { describe, test, expect, mock } from "bun:test";
import type { ProviderCompleteArgs } from "../src/llm/types.js";
import type { NodeConfigIndex } from "../src/evals-engine/conversation-input.js";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { MockLLM } = await import("../src/llm/index.js");
const { fromSimTranscript } = await import("../src/evals-engine/conversation-input.js");
const { evaluateSimulationForRun } = await import("../src/evals-engine/integration/sim-adapter.js");
type EvalTurn = import("../src/evals-engine/types.js").EvalTurn;

// The judges' node lookup: nodeUuid → {config, configName, metaName}, built from the flow JSON on
// the run path.
function indexWith(nodes: Array<{ id: string; name: string; config: Record<string, unknown> }>): NodeConfigIndex {
  return new Map(nodes.map((n) => [n.id, { config: n.config, configName: n.name, metaName: n.name }]));
}
const aiNode = (id: string, name: string, config: Record<string, unknown>) => ({ id, name, config });

const FLOW_OBJ = {
  flow_name: "orders",
  systemPrompt: { prompt: "You are an orders agent." },
  agent_settings: { conversation_goals: [{ goal_name: "confirm", goal_instructions: "confirm the order", flow_goal_id: 5 }] },
};

const TURNS: EvalTurn[] = [
  { node_uuid: "A1", user: "hi", agent: "hello, order id?", intent: "" },
  { node_uuid: "A1", user: "order 42", agent: "got 42", intent: "provide_order" },
  { node_uuid: "A2", user: "", agent: "confirmed", intent: "done" },
];

const INDEX = indexWith([
  aiNode("A1", "collect_order", { instructions: "Ask for order id", intents: [{ id: "e1", intent_name: "provide_order" }], extract_variables: [{ variable_name: "order_id" }] }),
  aiNode("A2", "confirm", { instructions: "Confirm the order" }),
]);

function judgeResponder(args: ProviderCompleteArgs): string {
  const s = args.system;
  if (s.includes("fabricated information")) return JSON.stringify({ hallucinated: false, score: 1, reason: "" });
  if (s.includes("Variables expected to be extracted")) return JSON.stringify({ extraction_successful: true, score: 1, reason: "" });
  if (s.includes("repeat its own previous messages")) return JSON.stringify({ loop_detected: false, score: 1, reason: "" });
  if (s.includes("correct intent for the conversation segment")) return JSON.stringify({ intent_not_found: false, intent_wrongly_identified: false, reason: "" });
  if (s.includes("four-part rubric"))
    return JSON.stringify({
      objective_progress: { achieved: true, score: 1 },
      procedure_compliance: { score: 1, missed_steps: [] },
      interaction_quality: { score: 1, issues: [] },
      policy_boundary_compliance: { passed: true, score: 1 },
    });
  if (s.includes("configured goals were achieved")) return JSON.stringify({ goals: [{ goal_name: "confirm", achieved: true, reason: "" }] });
  return "{}";
}

describe("fromSimTranscript", () => {
  test("groups turns by node, reads config + goals + global prompt", () => {
    const input = fromSimTranscript({ turns: TURNS, nodeIndex: INDEX, flowObj: FLOW_OBJ, variablesByNode: { A1: { order_id: "42" } } });
    expect(input.flow_name).toBe("orders");
    expect(input.global_prompt).toBe("You are an orders agent.");
    expect(input.nodes).toHaveLength(2);

    const a1 = input.nodes[0]!;
    expect(a1.node_uuid).toBe("A1");
    expect(a1.node_name).toBe("collect_order");
    expect(a1.node_prompt).toBe("Ask for order id");
    expect(a1.chosen_intent).toBe("provide_order"); // last non-empty intent at A1
    expect(a1.required_variables).toEqual(["order_id"]);
    expect(a1.extracted_variables).toEqual({ order_id: "42" });
    expect(a1.turn_count).toBe(2);

    expect(input.goals).toEqual([{ goal_name: "confirm", goal_instructions: "confirm the order", flow_goal_id: 5 }]);
    expect(input.full_transcript).toContain("User: order 42");
  });

  test("no goals when agent_settings has none", () => {
    const input = fromSimTranscript({ turns: TURNS, nodeIndex: INDEX, flowObj: { flow_name: "x" }, variablesByNode: {} });
    expect(input.goals).toEqual([]);
  });
});

describe("evaluateSimulationForRun (adapter — never throws)", () => {
  test("success → { evaluation } with node_evaluations + goal_evaluation", async () => {
    const out = await evaluateSimulationForRun({
      turns: TURNS,
      nodeIndex: INDEX,
      flowObj: FLOW_OBJ,
      variablesByNode: { A1: { order_id: "42" } },
      scenarioId: "s1",
      flowUuid: "flow-1",
      runUuid: "run-1",
      provider: new MockLLM([judgeResponder]),
    });
    expect(out.eval_error).toBeUndefined();
    expect(out.evaluation!.node_evaluations).toHaveLength(2);
    expect(out.evaluation!.goal_evaluation!.goals[0]).toMatchObject({ goal_name: "confirm", flow_goal_id: 5, achieved: true });
    // cx-sqs ConversationEvaluation wrapper (raw-JSON parity)
    expect(out.evaluation!.flow_uuid).toBe("flow-1");
    expect(out.evaluation!.flow_name).toBe("orders");
    expect(out.evaluation!.run_uuid).toBe("run-1");
    expect(out.evaluation!.conversation_metrics).toMatchObject({
      answered: false,
      is_agent_runner: false,
      bot_detected: { detected: false, detected_value: 0 },
      user_sentiment: { sentiment: "" },
      stt: { error_count: 0, recovered_count: 0, available: false },
    });
    // key order matches cx-sqs: flow_uuid, flow_name, run_uuid, conversation_metrics, node_evaluations, goal_evaluation
    expect(Object.keys(out.evaluation!)).toEqual([
      "flow_uuid", "flow_name", "run_uuid", "conversation_metrics", "node_evaluations", "goal_evaluation",
    ]);
  });

  test("judge failure → { eval_error: true } (scenario still completes)", async () => {
    const out = await evaluateSimulationForRun({
      turns: TURNS,
      nodeIndex: INDEX,
      flowObj: FLOW_OBJ,
      variablesByNode: {},
      scenarioId: "s1",
      flowUuid: "flow-1",
      runUuid: "run-1",
      provider: new MockLLM(["not json"]),
    });
    expect(out.evaluation).toBeUndefined();
    expect(out.eval_error).toBe(true);
  });

  test("empty transcript → {} (no eval, no error)", async () => {
    const out = await evaluateSimulationForRun({ turns: [], nodeIndex: INDEX, flowObj: FLOW_OBJ, variablesByNode: {}, scenarioId: "s1", flowUuid: "flow-1", runUuid: "run-1", provider: new MockLLM([judgeResponder]) });
    expect(out).toEqual({});
  });
});
