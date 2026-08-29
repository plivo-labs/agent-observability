import { describe, test, expect, mock } from "bun:test";
import type { ProviderCompleteArgs } from "../src/llm/types.js";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { MockLLM } = await import("../src/llm/index.js");
const { runCriteriaJudge, aggregateCriteriaScore } = await import("../src/evals-engine/judges/criteria-judge.js");
const { evaluateSimulation } = await import("../src/evals-engine/index.js");
const { evaluateSimulationForRun } = await import("../src/evals-engine/integration/sim-adapter.js");
type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;
type CriterionResult = import("../src/evals-engine/types.js").CriterionResult;

const crit = (over: Partial<CriterionResult>): CriterionResult => ({
  id: 1,
  description: "c",
  applicable: true,
  met: true,
  accuracy_score: 1,
  evidence: '"x"',
  ...over,
});

const ctx = (): ConversationInput => ({
  flow_name: "f",
  global_prompt: "",
  nodes: [],
  goals: [],
  full_transcript: "User: hi\nAgent: hello there",
});

describe("aggregateCriteriaScore (min over applicable, Hunter parity)", () => {
  test("min over applicable criteria", () => {
    expect(aggregateCriteriaScore([crit({ accuracy_score: 0.8 }), crit({ id: 2, accuracy_score: 0.4 })])).toBe(0.4);
  });
  test("N/A criteria excluded from the min", () => {
    expect(
      aggregateCriteriaScore([crit({ applicable: false, met: null, accuracy_score: null }), crit({ id: 2, accuracy_score: 0.9 })]),
    ).toBe(0.9);
  });
  test("all N/A → 1.0 (nothing applicable was violated)", () => {
    expect(aggregateCriteriaScore([crit({ applicable: false, met: null, accuracy_score: null })])).toBe(1.0);
  });
  test("empty verdict → 0.0 (fail)", () => {
    expect(aggregateCriteriaScore([])).toBe(0.0);
  });
});

describe("runCriteriaJudge", () => {
  test("quote-or-zero: an applicable criterion with no evidence scores 0 and tanks the min", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        criteria: [
          { id: 1, description: "a", applicable: true, met: true, accuracy_score: 1.0, evidence: '"hello there"' },
          { id: 2, description: "b", applicable: true, met: true, accuracy_score: 0.9, evidence: "" },
        ],
      }),
    ]);
    const { data } = await runCriteriaJudge(["a", "b"], ctx(), llm);
    expect(data.criteria[1]!.accuracy_score).toBe(0); // no quote → 0 regardless of self-score
    expect(data.score).toBe(0); // min(1, 0)
  });

  test("N/A criterion is excluded and reported with null met/accuracy", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        criteria: [
          { id: 1, description: "cond", applicable: false, met: null, accuracy_score: null, evidence: "precondition never occurred" },
          { id: 2, description: "b", applicable: true, met: true, accuracy_score: 0.75, evidence: '"x"' },
        ],
      }),
    ]);
    const { data } = await runCriteriaJudge(["cond", "b"], ctx(), llm);
    expect(data.criteria[0]!.applicable).toBe(false);
    expect(data.criteria[0]!.met).toBeNull();
    expect(data.criteria[0]!.accuracy_score).toBeNull();
    expect(data.score).toBe(0.75); // only the applicable one counts
  });
});

describe("evaluateSimulation — criteria threshold gate", () => {
  test("criteria judge runs only when acceptance_criteria are non-empty", async () => {
    const none = await evaluateSimulation(ctx(), { provider: new MockLLM([]) });
    expect(none.criteria_evaluation).toBeUndefined();
  });

  test("score ≥ threshold → passed true", async () => {
    const llm = new MockLLM([JSON.stringify({ criteria: [{ id: 1, description: "a", applicable: true, met: true, accuracy_score: 0.9, evidence: '"x"' }] })]);
    const ev = await evaluateSimulation(ctx(), { provider: llm, acceptanceCriteria: ["a"], criteriaThreshold: 0.8 });
    expect(ev.criteria_evaluation!.score).toBe(0.9);
    expect(ev.criteria_evaluation!.threshold).toBe(0.8);
    expect(ev.criteria_evaluation!.passed).toBe(true);
  });

  test("score < threshold → passed false", async () => {
    const llm = new MockLLM([JSON.stringify({ criteria: [{ id: 1, description: "a", applicable: true, met: false, accuracy_score: 0.5, evidence: '"x"' }] })]);
    const ev = await evaluateSimulation(ctx(), { provider: llm, acceptanceCriteria: ["a"], criteriaThreshold: 0.8 });
    expect(ev.criteria_evaluation!.passed).toBe(false);
  });
});

describe("criteria parse failure → eval_error (via the adapter)", () => {
  // Content-aware responder: valid JSON for the node judges, unparseable for the criteria judge.
  const responder = (args: ProviderCompleteArgs): string => {
    const s = args.system;
    if (s.includes("acceptance criterion")) return "not json at all";
    if (s.includes("fabricated information")) return JSON.stringify({ hallucinated: false, score: 1, reason: "", technical_reason: "" });
    if (s.includes("Variables expected to be extracted")) return JSON.stringify({ extraction_successful: true, score: 1, reason: "", technical_reason: "" });
    if (s.includes("repeat its own previous messages")) return JSON.stringify({ loop_detected: false, score: 1, reason: "", technical_reason: "" });
    if (s.includes("correct intent for the conversation segment")) return JSON.stringify({ intent_not_found: false, intent_wrongly_identified: false, reason: "", technical_reason: "" });
    if (s.includes("four-part rubric"))
      return JSON.stringify({
        objective_progress: { achieved: true, score: 1, reason_code: "goal_achieved", reason: "", technical_reason: "" },
        procedure_compliance: { score: 1, reason_code: "", missed_steps: [], reason: "", technical_reason: "" },
        interaction_quality: { score: 1, reason_code: "", issues: [], reason: "", technical_reason: "" },
        policy_boundary_compliance: { passed: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
      });
    return "{}";
  };

  test("a criteria judge that never parses becomes eval_error (node/goal work is discarded)", async () => {
    const out = await evaluateSimulationForRun({
      turns: [{ node_uuid: "n1", user: "hi", agent: "hello", intent: "" }],
      nodeIndex: new Map([["n1", { config: null, configName: "n1", metaName: "n1" }]]),
      flowObj: { flow_name: "f", nodes: [] },
      variablesByNode: {},
      scenarioId: "s",
      flowUuid: "f",
      runUuid: "r",
      provider: new MockLLM([responder]),
      acceptanceCriteria: ["a"],
      criteriaThreshold: 0.8,
    });
    expect(out.eval_error).toBe(true);
    expect(out.evaluation).toBeUndefined();
  });
});
