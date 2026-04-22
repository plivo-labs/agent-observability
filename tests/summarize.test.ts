import { describe, test, expect } from "bun:test";
import { summarize } from "../src/evals/summarize.js";

function mkCase(overrides: any) {
  return {
    case_id: "c",
    name: "t",
    status: "passed",
    events: [],
    judgments: [],
    ...overrides,
  };
}

describe("summarize()", () => {
  test("totals match input length regardless of rule", () => {
    const cases = [
      mkCase({ status: "passed" }),
      mkCase({ status: "failed" }),
      mkCase({ status: "errored" }),
      mkCase({ status: "skipped" }),
    ] as any;
    const r = summarize(cases);
    expect(r.total).toBe(4);
    expect(r.errored).toBe(1);
    expect(r.skipped).toBe(1);
    // passed + failed + errored + skipped === total
    expect(r.passed + r.failed + r.errored + r.skipped).toBe(r.total);
  });

  test("empty input returns all zeros", () => {
    const r = summarize([]);
    expect(r).toEqual({ total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 });
  });

  test("only errored/skipped cases are counted as such", () => {
    const cases = [
      mkCase({ status: "errored" }),
      mkCase({ status: "errored" }),
      mkCase({ status: "skipped" }),
    ] as any;
    const r = summarize(cases);
    expect(r.errored).toBe(2);
    expect(r.skipped).toBe(1);
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(0);
  });
});
