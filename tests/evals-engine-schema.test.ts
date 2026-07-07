import { describe, test, expect } from "bun:test";
import {
  HallucinationRawZ,
  VariableExtractionRawZ,
  NodeLoopRawZ,
  InstructionAdherenceRawZ,
  GoalRawZ,
  NodeGoalEvaluationZ,
  EvaluationResultZ,
} from "../src/evals-engine/judges/types.js";
import {
  fill,
  HALLUCINATION,
  systemForHallucination,
  systemForVariableExtraction,
  systemForInstructionAdherence,
  systemForGoal,
} from "../src/evals-engine/judges/instructions.js";

// E0 — the contract + schemas parse, and prompt composition fills slots + appends the output section.

describe("raw judge schemas", () => {
  test("hallucination raw parses; score coerces from string; reason defaults", () => {
    const r = HallucinationRawZ.parse({ hallucinated: false, score: "0.8" });
    expect(r.score).toBe(0.8);
    expect(r.reason).toBe("");
  });

  test("variable + loop raw parse", () => {
    expect(VariableExtractionRawZ.parse({ extraction_successful: true, score: 1 }).extraction_successful).toBe(true);
    expect(NodeLoopRawZ.parse({ loop_detected: false, score: 1 }).loop_detected).toBe(false);
  });

  test("instruction-adherence raw parses the 4 sub-metrics; missed_steps/issues default to []", () => {
    const r = InstructionAdherenceRawZ.parse({
      objective_progress: { achieved: true, score: 1 },
      procedure_compliance: { score: 1 },
      interaction_quality: { score: 0.9 },
      policy_boundary_compliance: { passed: true, score: 1 },
    });
    expect(r.procedure_compliance.missed_steps).toEqual([]);
    expect(r.interaction_quality.issues).toEqual([]);
    expect(r.objective_progress.achieved).toBe(true);
  });

  test("goal raw parses a per-goal array", () => {
    const r = GoalRawZ.parse({ goals: [{ goal_name: "book", achieved: true }] });
    expect(r.goals[0]!.goal_name).toBe("book");
  });
});

describe("evaluator contract (NodeGoalEvaluationZ) + emitted wrapper (EvaluationResultZ)", () => {
  const golden = {
    node_evaluations: [
      {
        node_uuid: "n1",
        node_name: "greeting",
        turn_count: 2,
        instructions_adherence: {
          adherence_passed: true,
          score: 0.92,
          reason: "followed",
          technical_reason: "…",
          objective_progress: { achieved: true, score: 1, reason_code: "goal_achieved", reason: "", technical_reason: "" },
          procedure_compliance: { passed: true, score: 1, missed_steps: [], reason_code: "", reason: "", technical_reason: "" },
          interaction_quality: { score: 0.8, issues: [], reason_code: "", reason: "", technical_reason: "" },
          policy_boundary_compliance: { passed: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
        },
        intent_identification: { reason: "", technical_reason: "", intent_not_found: false, intent_wrongly_identified: false, score: 1 },
        variable_extraction: { extraction_successful: true, score: 1, reason: "", technical_reason: "", required_variables: ["order_id"], missing_variables: [], incorrect_variables: [] },
        hallucination: { hallucinated: false, score: 1, reason: "", technical_reason: "" },
        node_loop: { loop_detected: false, score: 1, reason: "", technical_reason: "" },
      },
    ],
    goal_evaluation: { goals: [{ goal_name: "book", flow_goal_id: 0, achieved: true, reason: "", technical_reason: "" }] },
  };

  test("evaluator output (node + goal, no header) validates", () => {
    expect(() => NodeGoalEvaluationZ.parse(golden)).not.toThrow();
  });

  test("goal_evaluation is optional (no-goals case)", () => {
    const noGoals = { node_evaluations: golden.node_evaluations };
    expect(() => NodeGoalEvaluationZ.parse(noGoals)).not.toThrow();
  });

  test("emitted wrapper requires the cx-sqs header + conversation_metrics", () => {
    const wrapped = { flow_uuid: "f", flow_name: "orders", run_uuid: "r", conversation_metrics: {}, ...golden };
    expect(() => EvaluationResultZ.parse(wrapped)).not.toThrow();
    // The bare evaluator output (no header) must NOT validate as the emitted wrapper.
    expect(() => EvaluationResultZ.parse(golden)).toThrow();
  });
});

describe("prompt composition", () => {
  test("fill replaces known slots, leaves unknown ones", () => {
    expect(fill("a {x} b {y}", { x: "1" })).toBe("a 1 b {y}");
  });

  test("criteria body is the SDK wording; composed prompt appends the JSON output section", () => {
    expect(HALLUCINATION).toContain("fabricated information not supported by any valid evidence source");
    const sys = systemForHallucination();
    expect(sys).toContain("fabricated information");
    expect(sys).toContain('"hallucinated": boolean');
  });

  test("slotted prompts inject their ground truth", () => {
    expect(systemForVariableExtraction("- order_id", "- order_id: 42")).toContain("order_id");
    expect(systemForInstructionAdherence("Be nice", "greet the user")).toContain("greet the user");
    expect(systemForGoal("- book a table", "…history…")).toContain("book a table");
  });

  test("goal prompt carries the early-termination rule always, sim rules only for simulation (E1)", () => {
    const live = systemForGoal("- g", "h"); // isSimulation defaults false
    const sim = systemForGoal("- g", "h", true);
    // Early-termination rule is unconditional (cx-sqs system.tmpl) — present in both.
    expect(live).toContain("Early termination");
    expect(sim).toContain("Early termination");
    // The success-proxy / SIMULATION CONTEXT block is sim-only (cx-sqs user.tmpl IsSimulation).
    expect(live).not.toContain("SIMULATION CONTEXT");
    expect(live).not.toContain("Success proxy");
    expect(sim).toContain("SIMULATION CONTEXT");
    expect(sim).toContain("Success proxy rule");
  });
});
