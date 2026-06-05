import { describe, test, expect, mock, beforeEach } from "bun:test";
import { randomUUID } from "crypto";

// Capture every tagged-template interpolation insertEvalRun issues so we can
// assert jsonb columns are bound as raw JS values (objects/arrays) and NEVER as
// pre-stringified JSON — stringifying double-encodes into a jsonb string scalar
// ("[…]") that breaks raw jsonb operators downstream (see CLAUDE.md gotcha).
const runInserts: any[][] = [];
const caseInserts: any[][] = [];
let sawRunInsert = false;

function tx(_strings: TemplateStringsArray, ...values: any[]) {
  // First tx call inside a begin() is the eval_runs insert; the rest are cases.
  if (!sawRunInsert) { runInserts.push(values); sawRunInsert = true; }
  else { caseInserts.push(values); }
  return Promise.resolve([]);
}

mock.module("../src/db.js", () => ({
  sql: {
    begin: async (fn: (t: typeof tx) => Promise<void>) => {
      sawRunInsert = false;
      await fn(tx);
    },
  },
}));

const { insertEvalRun } = await import("../src/evals/db.js");

function buildPayload(): any {
  return {
    version: "v0",
    run: {
      run_id: randomUUID(),
      account_id: "acct-1",
      agent_id: "support-bot",
      testing_framework: "simulation",
      started_at: 1714000000,
      finished_at: 1714000060,
      ci: { provider: "github", git_sha: "abc123" },
      sim_report: { overall: "pass", personas: [{ name: "p1", score: 0.9 }] },
    },
    cases: [
      {
        case_id: randomUUID(),
        name: "ok",
        status: "passed",
        events: [{ type: "message", role: "assistant", content: "hi" }],
        judgments: [{ intent: "greets", verdict: "pass", reasoning: "ok" }],
      },
      {
        case_id: randomUUID(),
        name: "bad",
        status: "failed",
        events: [],
        judgments: [{ intent: "refuses", verdict: "fail", reasoning: "complied" }],
        failure: { kind: "judge_failed", message: "verdict=fail" },
      },
    ],
  };
}

describe("insertEvalRun jsonb binding", () => {
  beforeEach(() => {
    runInserts.length = 0;
    caseInserts.length = 0;
  });

  test("binds every jsonb column as a raw JS value, not a stringified blob", async () => {
    const payload = buildPayload();
    await insertEvalRun(payload);

    expect(runInserts).toHaveLength(1);
    expect(caseInserts).toHaveLength(2);

    // eval_runs VALUES order → ci is index 15, sim_report index 16.
    const runVals = runInserts[0];
    const ci = runVals[15];
    const simReport = runVals[16];
    expect(typeof ci).not.toBe("string");
    expect(ci).toEqual(payload.run.ci);
    expect(typeof simReport).not.toBe("string");
    expect(simReport).toEqual(payload.run.sim_report);

    // eval_cases VALUES order → events idx 7, judgments idx 8, failure idx 9.
    for (const caseVals of caseInserts) {
      expect(Array.isArray(caseVals[7])).toBe(true); // events
      expect(Array.isArray(caseVals[8])).toBe(true); // judgments
      const failure = caseVals[9];
      // failure is null when absent, an object when present — never a string.
      expect(typeof failure).not.toBe("string");
    }

    // The failing case carries a structured failure object.
    const failing = caseInserts.find((v) => v[2] === "bad")!;
    expect(failing[9]).toEqual({ kind: "judge_failed", message: "verdict=fail" });
  });

  test("absent jsonb fields bind null/[] — still not stringified", async () => {
    const payload = buildPayload();
    delete payload.run.ci;
    delete payload.run.sim_report;
    payload.cases = [{ case_id: randomUUID(), name: "x", status: "passed" }];
    await insertEvalRun(payload);

    const runVals = runInserts[0];
    expect(runVals[15]).toBeNull(); // ci
    expect(runVals[16]).toBeNull(); // sim_report

    const caseVals = caseInserts[0];
    expect(Array.isArray(caseVals[7])).toBe(true); // events defaults to []
    expect(Array.isArray(caseVals[8])).toBe(true); // judgments defaults to []
    expect(caseVals[9]).toBeNull(); // failure
  });
});
