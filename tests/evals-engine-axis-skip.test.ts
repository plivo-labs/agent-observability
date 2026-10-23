import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { MockLLM } = await import("../src/llm/index.js");
const { MockJev } = await import("../src/jev/mock.js");
const { evaluateIngestedSession } = await import("../src/evals-engine/integration/session-evals.js");
const { buildExternalEvalRows } = await import("../src/evals-engine/fan-out-rows.js");
const { defaultJudgeResponder } = await import("./fixtures/default-judge-responder.js");
type AgentConfigNode = import("../src/evals-engine/integration/session-evals.js").AgentConfigNode;
type StoredEvent = import("../src/evals-engine/integration/session-evals.js").StoredEvent;
type Row = ReturnType<typeof buildExternalEvalRows>[number];

const CONFIG_AXES = ["instructions_adherence", "intent_identification", "variable_extraction"] as const;
const NODE_AXES = [...CONFIG_AXES, "hallucination", "node_loop"];

const configured: AgentConfigNode = {
  ref: "node-A",
  name: "collect_order",
  instructions: "Ask for the order id and confirm it.",
  intents: [{ name: "provide_order", description: "the caller states their order id", tool: "handoff_order" }],
  variables: [{ name: "order_id", rule: "Record the order id the caller states.", tool: "record_order_id" }],
};

const events = (ref: string): StoredEvent[] => [
  { type: "conversation_item_added", node_ref: ref, item: { type: "message", role: "assistant", content: "What is your order id?" } },
  { type: "conversation_item_added", node_ref: ref, item: { type: "message", role: "user", content: "It is 42." } },
  { type: "conversation_item_added", node_ref: ref, item: { type: "function_call", name: "record_order_id", arguments: "{\"value\":\"42\"}" } },
  { type: "conversation_item_added", node_ref: ref, item: { type: "message", role: "assistant", content: "Thanks, order 42 confirmed." } },
];

const llm = () =>
  new MockLLM([(args: any) => {
    const system = args.system as string;
    if (system.includes("calibrated classifier")) {
      const asked = JSON.parse(args.user as string).items as Array<{ id: string }>;
      return JSON.stringify({ reasons: asked.map((d) => ({ id: d.id, reason: `why ${d.id}`, technical_reason: `tech ${d.id}` })) });
    }
    return defaultJudgeResponder(system) ?? JSON.stringify({ detected: false, reason: "r", technical_reason: "t" });
  }]);

async function nodeRows(node: AgentConfigNode, transcriptRef: string, jev?: InstanceType<typeof MockJev>): Promise<Map<string, Row>> {
  const verdicts = await evaluateIngestedSession(
    { flow_name: "orders", global_prompt: "You are an orders agent.", nodes: [node] },
    events(transcriptRef), llm(), "livekit", undefined, undefined, [], jev as any,
  );
  return new Map(buildExternalEvalRows(verdicts).filter((r) => NODE_AXES.includes(r.judgeName)).map((r) => [r.judgeName, r]));
}

const expectPass = (row: Row | undefined) => {
  expect(row?.passed).toBe(true);
  expect(row?.verdictText).toBeUndefined();
};

describe("an axis with nothing to judge is unknown, never a pass", () => {
  const cases: Array<{ skipped: (typeof CONFIG_AXES)[number] | null; node: AgentConfigNode }> = [
    { skipped: null, node: configured },
    { skipped: "instructions_adherence", node: { ...configured, instructions: "  " } },
    { skipped: "intent_identification", node: { ...configured, intents: [] } },
    { skipped: "variable_extraction", node: { ...configured, variables: [] } },
  ];
  for (const { skipped, node } of cases) {
    test(skipped ? `no ${skipped} config → that row is unknown, the rest pass` : "a fully configured node passes on every axis", async () => {
      const rows = await nodeRows(node, "node-A");
      expect([...rows.keys()].sort()).toEqual([...NODE_AXES].sort());
      for (const axis of NODE_AXES) {
        const row = rows.get(axis)!;
        if (axis !== skipped) {
          expectPass(row);
          expect(row.raw.not_applicable).toBeUndefined();
          continue;
        }
        expect(row.verdictText).toBe("unknown");
        expect(row.passed).toBe(false);
        expect(row.raw.not_applicable).toBe(true);
        expect(row.raw.not_judged).toBeUndefined();
        expect(row.reasoning).toContain("not applicable");
      }
    });
  }

  test("a skip keeps its stored booleans; the marker and the row say unknown", async () => {
    const rows = await nodeRows({ ref: "node-A", name: "router" }, "node-A");
    for (const axis of CONFIG_AXES) {
      expect(rows.get(axis)!.raw.not_applicable).toBe(true);
      expect(rows.get(axis)!.verdictText).toBe("unknown");
    }
    const adherence = rows.get("instructions_adherence")!.raw as any;
    expect(adherence.adherence_passed).toBe(true);
    expect(adherence.objective_progress.achieved).toBe(true);
    expect(adherence.procedure_compliance.passed).toBe(true);
    expect(adherence.policy_boundary_compliance.passed).toBe(true);
    expect(rows.get("variable_extraction")!.raw.extraction_successful).toBe(true);
    expect(rows.get("intent_identification")!.raw.intent_not_found).toBe(false);
    expect(rows.get("intent_identification")!.raw.intent_wrongly_identified).toBe(false);
  });
});

describe("the simulation path", () => {
  const turns = [
    { node_uuid: "n1", user: "", agent: "What is your order id?", intent: "" },
    { node_uuid: "n1", user: "It is 42.", agent: "", intent: "" },
  ];
  const input = {
    flow_name: "orders", global_prompt: "You are an orders agent.", goals: [],
    full_transcript: "Agent: What is your order id?\nUser: It is 42.",
    nodes: [{ node_uuid: "n1", node_name: "router", node_prompt: "", available_intents: [], chosen_intent: "", required_variables: [], extracted_variables: {}, turns, turn_count: 2 }],
  };
  const skipped = (reason: string) => ({ score: 1, reason_code: "not_applicable", reason, technical_reason: "skipped: node has no instructions" });
  const originDevOutput = {
    node_evaluations: [{
      node_uuid: "n1", node_name: "router", turn_count: 2,
      instructions_adherence: {
        adherence_passed: true, score: 1,
        reason: "Instructions followed across objective, procedure, and policy.",
        technical_reason: Array(4).fill("skipped: node has no instructions").join(" | "),
        objective_progress: { achieved: true, ...skipped("No instructions configured on this node — adherence not applicable.") },
        procedure_compliance: { ...skipped("No procedure defined."), missed_steps: [], passed: true },
        interaction_quality: { ...skipped("Not evaluated."), issues: [] },
        policy_boundary_compliance: { passed: true, ...skipped("No policy boundaries defined.") },
        config_conflicts: [],
      },
      intent_identification: {
        intent_not_found: false, intent_wrongly_identified: false, score: 1,
        reason: "No intents configured on this node — intent identification not applicable.",
        technical_reason: "skipped: empty available_intents",
      },
      variable_extraction: {
        extraction_successful: true, score: 1,
        reason: "No variables declared on this node — extraction not applicable.",
        technical_reason: "skipped: node declares no required_variables",
        required_variables: [], missing_variables: [], incorrect_variables: [],
      },
      hallucination: { hallucinated: false, score: 1, reason: "", technical_reason: "" },
      node_loop: { loop_detected: false, score: 1, reason: "", technical_reason: "" },
    }],
  };

  test("a node with nothing declared scores exactly as on origin/dev, plus the marker", async () => {
    const { evaluateSimulation } = await import("../src/evals-engine/evaluator.js");
    const out = await evaluateSimulation(input as any, { provider: llm() });
    const node = out.node_evaluations[0] as any;
    for (const axis of CONFIG_AXES) {
      expect(node[axis].not_applicable).toBe(true);
      delete node[axis].not_applicable;
    }
    expect(out).toEqual(originDevOutput as any);
  });
});

describe("a node the agent config does not know", () => {
  test("is not judged on the three config axes; hallucination and loop still run", async () => {
    const rows = await nodeRows(configured, "node-unlisted");
    for (const axis of CONFIG_AXES) {
      const row = rows.get(axis)!;
      expect(row.verdictText).toBe("unknown");
      expect(row.passed).toBe(false);
      expect(row.raw.not_judged).toBe(true);
      expect(row.raw.not_applicable).toBeUndefined();
      expect(row.reasoning).toContain("missing from the agent config");
    }
    expectPass(rows.get("hallucination"));
    expectPass(rows.get("node_loop"));
  });
});

describe("the Jev path writes the same skip rows", () => {
  const view = (r: Row | undefined) => r && { tag: r.tag, passed: r.passed, verdictText: r.verdictText, reasoning: r.reasoning, not_applicable: r.raw.not_applicable, not_judged: r.raw.not_judged };
  const scenarios: Array<[string, AgentConfigNode, string]> = [
    ["nothing declared", { ref: "node-A", name: "router" }, "node-A"],
    ["node missing from config", configured, "node-unlisted"],
  ];
  for (const [label, node, ref] of scenarios) {
    test(label, async () => {
      const llmOnly = await nodeRows(node, ref);
      const jevFirst = await nodeRows(node, ref, new MockJev([{}], 0.01));
      for (const axis of CONFIG_AXES) {
        expect(view(jevFirst.get(axis))).toEqual(view(llmOnly.get(axis)));
        expect(jevFirst.get(axis)?.verdictText).toBe("unknown");
      }
    });
  }
});
