import { describe, test, expect } from "bun:test";
import { extractGoalPassed } from "../src/sim-engine/db.js";

// Tri-state goal outcome — must mirror the orchestrator service's `_extract_goal_passed`
// exactly: the pass/fail run counters derive from this, and a drift here silently skews
// every dashboard pass rate. null = NEITHER counter moves (passed+failed ≤ completed).

const goals = (...achieved: boolean[]) => ({
  goal_evaluation: { goals: achieved.map((a, i) => ({ goal_name: `g${i}`, achieved: a })) },
});

describe("extractGoalPassed (tri-state, ANY-goal)", () => {
  test("scenario error → null (neither counter)", () => {
    expect(extractGoalPassed({ error: "boom", evaluation: goals(true) })).toBeNull();
  });

  test("eval_error → null", () => {
    expect(extractGoalPassed({ evalError: true, evaluation: goals(true) })).toBeNull();
  });

  test("missing / non-object evaluation → null", () => {
    expect(extractGoalPassed({})).toBeNull();
    expect(extractGoalPassed({ evaluation: null })).toBeNull();
    expect(extractGoalPassed({ evaluation: "not-an-object" })).toBeNull();
  });

  test("missing goal_evaluation or empty goals → null", () => {
    expect(extractGoalPassed({ evaluation: {} })).toBeNull();
    expect(extractGoalPassed({ evaluation: { goal_evaluation: {} } })).toBeNull();
    expect(extractGoalPassed({ evaluation: { goal_evaluation: { goals: [] } } })).toBeNull();
  });

  test("ANY goal achieved → true (not all-goals)", () => {
    expect(extractGoalPassed({ evaluation: goals(false, true, false) })).toBe(true);
  });

  test("no goal achieved → false", () => {
    expect(extractGoalPassed({ evaluation: goals(false, false) })).toBe(false);
  });

  test("malformed goal entries are not counted as achieved", () => {
    const evaluation = { goal_evaluation: { goals: [null, "junk", { achieved: false }] } };
    expect(extractGoalPassed({ evaluation })).toBe(false);
  });
});

describe("extractGoalPassed precedence (criteria over flow goals)", () => {
  const criteria = (passed: boolean) => ({ criteria_evaluation: { threshold: 0.7, score: passed ? 1 : 0, passed, criteria: [] } });

  test("criteria_evaluation is authoritative over flow goals", () => {
    expect(extractGoalPassed({ evaluation: { ...criteria(false), ...goals(true) } })).toBe(false);
    expect(extractGoalPassed({ evaluation: { ...criteria(true), ...goals(false) } })).toBe(true);
  });

  test("no criteria → falls back to the ANY-goal rule", () => {
    expect(extractGoalPassed({ evaluation: goals(false, true) })).toBe(true);
  });

  test("caller_goal_met / caller_hung_up are not special-cased — judged by criteria/goals", () => {
    expect(extractGoalPassed({ evaluation: criteria(false) })).toBe(false);
    expect(extractGoalPassed({ evaluation: goals(true) })).toBe(true);
  });
});
