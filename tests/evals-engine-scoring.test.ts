import { describe, test, expect } from "bun:test";
import { scoreJudge, scoreAll, type LabelledVerdict } from "../src/evals-engine/scoring.js";

/** n rows of one (judge_positive, truth_positive) combination. */
const rows = (judgeName: string, spec: { j: boolean; t: boolean; n: number }[]): LabelledVerdict[] =>
  spec.flatMap(({ j, t, n }) =>
    Array.from({ length: n }, () => ({ judge_name: judgeName, judge_positive: j, truth_positive: t })),
  );

describe("scoreJudge", () => {
  test("perfect judge scores 1.0 across the board", () => {
    const s = scoreJudge("hallucination", rows("hallucination", [
      { j: true, t: true, n: 10 },
      { j: false, t: false, n: 90 },
    ]));
    expect(s.tp).toBe(10);
    expect(s.fp).toBe(0);
    expect(s.tn).toBe(90);
    expect(s.fn).toBe(0);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.balanced_accuracy).toBe(1);
    expect(s.youden_j).toBe(1);
    expect(s.cohens_kappa).toBe(1);
  });

  test("high accuracy hides low precision on a rare defect", () => {
    // The shape AO is actually in: 30% flag precision alongside high accuracy.
    // 3 real defects caught, 7 false flags, 90 clean calls passed.
    const s = scoreJudge("low_engagement", rows("low_engagement", [
      { j: true, t: true, n: 3 },
      { j: true, t: false, n: 7 },
      { j: false, t: false, n: 90 },
    ]));
    expect(s.accuracy).toBeCloseTo(0.93, 5);      // looks great
    expect(s.precision).toBeCloseTo(0.3, 5);      // is not great
    expect(s.recall).toBe(1);
    expect(s.specificity).toBeCloseTo(0.9278, 3);
    expect(s.balanced_accuracy).toBeCloseTo(0.9639, 3);
  });

  test("always-fire judge: BA collapses to 0.5, kappa to 0", () => {
    const s = scoreJudge("bot_detection", rows("bot_detection", [
      { j: true, t: true, n: 10 },
      { j: true, t: false, n: 90 },
    ]));
    expect(s.recall).toBe(1);
    expect(s.specificity).toBe(0);
    expect(s.balanced_accuracy).toBe(0.5);
    expect(s.youden_j).toBe(0);
    expect(s.cohens_kappa).toBe(0); // chance-level: no discrimination
  });

  test("never-fire judge: precision null (never fired), not 0", () => {
    const s = scoreJudge("wrong_number", rows("wrong_number", [
      { j: false, t: true, n: 10 },
      { j: false, t: false, n: 90 },
    ]));
    expect(s.precision).toBeNull();
    expect(s.recall).toBe(0);
    expect(s.specificity).toBe(1);
    expect(s.balanced_accuracy).toBe(0.5);
  });

  test("no truth positives => recall and BA are null, not 0", () => {
    const s = scoreJudge("node_loop", rows("node_loop", [
      { j: false, t: false, n: 50 },
    ]));
    expect(s.recall).toBeNull();
    expect(s.balanced_accuracy).toBeNull();
    expect(s.youden_j).toBeNull();
    expect(s.accuracy).toBe(1);
    expect(s.cohens_kappa).toBeNull(); // pe == 1, kappa undefined
  });

  test("empty input => n 0, every rate null", () => {
    const s = scoreJudge("hallucination", []);
    expect(s.n).toBe(0);
    expect(s.precision).toBeNull();
    expect(s.balanced_accuracy).toBeNull();
    expect(s.cohens_kappa).toBeNull();
  });

  test("scoreJudge ignores rows belonging to other judges", () => {
    const mixed = [...rows("a", [{ j: true, t: true, n: 5 }]), ...rows("b", [{ j: true, t: false, n: 5 }])];
    expect(scoreJudge("a", mixed).n).toBe(5);
    expect(scoreJudge("a", mixed).precision).toBe(1);
  });
});

describe("scoreAll", () => {
  test("one row per judge, sorted worst BA first, nulls last", () => {
    const all = scoreAll([
      ...rows("good", [{ j: true, t: true, n: 10 }, { j: false, t: false, n: 10 }]),
      ...rows("bad", [{ j: true, t: false, n: 10 }, { j: false, t: true, n: 10 }]),
      ...rows("ungraded", [{ j: false, t: false, n: 10 }]),
    ]);
    expect(all.map((s) => s.judge_name)).toEqual(["bad", "good", "ungraded"]);
    expect(all[0].balanced_accuracy).toBe(0);
    expect(all[2].balanced_accuracy).toBeNull();
  });
});
