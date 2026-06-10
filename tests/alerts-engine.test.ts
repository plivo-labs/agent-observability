import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockSql: any = mock((..._args: any[]) => Promise.resolve([]));
mockSql.unsafe = mock((..._args: any[]) => Promise.resolve([]));
mockSql.begin = mock((fn: (tx: any) => Promise<unknown>) => fn(mockSql));

// Full export surface: the first mock of a module fixes its export shape
// for the rest of the bun test run, and routes tests import names beyond
// `sql` from this module.
mock.module("../src/db.js", () => ({
  sql: mockSql,
  insertSession: mock(() => Promise.resolve()),
  applyStoredSessionTags: mock(() => Promise.resolve()),
  upsertSessionTag: mock(() => Promise.resolve()),
  insertLiveKitEvaluation: mock(() => Promise.resolve()),
  upsertSessionOutcome: mock(() => Promise.resolve()),
  applySessionTagMetadata: mock(() => Promise.resolve()),
  mergeSessionRawReport: mock(() => Promise.resolve()),
}));

const { evaluateRules } = await import("../src/alerts/engine.js");

const countRule = {
  id: "r1",
  trigger_type: "evaluation_count",
  judge_name: "task_completion",
  verdicts: ["fail"],
  threshold_count: 5,
  threshold_pass_rate: null,
  min_samples: 1,
  window_minutes: 15,
  agent_id: null,
  account_id: null,
};

const passRateRule = {
  id: "r2",
  trigger_type: "pass_rate",
  judge_name: null,
  verdicts: ["fail"],
  threshold_count: null,
  threshold_pass_rate: 0.8,
  min_samples: 5,
  window_minutes: 60,
  agent_id: null,
  account_id: null,
};

describe("alerts/engine evaluateRules", () => {
  beforeEach(() => {
    mockSql.mockClear();
    mockSql.unsafe.mockClear();
    mockSql.begin.mockClear();
    mockSql.mockImplementation((..._args: any[]) => Promise.resolve([]));
    mockSql.unsafe.mockImplementation((..._args: any[]) => Promise.resolve([]));
  });

  test("count rule fires at the threshold and stamps last_fired_at in a transaction", async () => {
    mockSql.mockResolvedValueOnce([countRule]); // rules list
    mockSql.unsafe.mockResolvedValueOnce([{ matched: 5, session_ids: ["s-1", "s-2"] }]);
    mockSql.mockResolvedValueOnce([{ id: "r1" }]); // suppression claim succeeds

    const fired = await evaluateRules();
    expect(fired).toBe(1);
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    // Window query received the verdicts as a JSONB string + judge filter.
    const params = mockSql.unsafe.mock.calls[0][1];
    expect(params[0]).toBe("15");
    expect(params[1]).toEqual(["fail"]);
    expect(params[2]).toBe("task_completion");
  });

  test("count rule below threshold does not fire", async () => {
    mockSql.mockResolvedValueOnce([countRule]);
    mockSql.unsafe.mockResolvedValueOnce([{ matched: 4, session_ids: [] }]);

    const fired = await evaluateRules();
    expect(fired).toBe(0);
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  test("pass_rate rule fires when rate is below threshold with enough samples", async () => {
    mockSql.mockResolvedValueOnce([passRateRule]);
    mockSql.unsafe.mockResolvedValueOnce([{ total: 10, passed: 6, session_ids: ["s-9"] }]);
    mockSql.mockResolvedValueOnce([{ id: "r2" }]); // suppression claim

    const fired = await evaluateRules();
    expect(fired).toBe(1); // 0.6 < 0.8 with 10 ≥ 5 samples
  });

  test("pass_rate rule stays quiet under min_samples", async () => {
    mockSql.mockResolvedValueOnce([passRateRule]);
    mockSql.unsafe.mockResolvedValueOnce([{ total: 3, passed: 0, session_ids: [] }]);

    const fired = await evaluateRules();
    expect(fired).toBe(0); // 0% pass but only 3 of 5 required samples
  });

  test("pass_rate rule stays quiet at or above the threshold", async () => {
    mockSql.mockResolvedValueOnce([passRateRule]);
    mockSql.unsafe.mockResolvedValueOnce([{ total: 10, passed: 9, session_ids: [] }]);

    const fired = await evaluateRules();
    expect(fired).toBe(0); // 0.9 ≥ 0.8
  });

  test("a failing rule does not block the others", async () => {
    mockSql.mockResolvedValueOnce([countRule, { ...countRule, id: "r3" }]);
    mockSql.unsafe
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([{ matched: 9, session_ids: [] }]);
    mockSql.mockResolvedValueOnce([{ id: "r3" }]); // suppression claim for r3

    const fired = await evaluateRules();
    expect(fired).toBe(1);
  });

  test("a lost suppression claim does not count as a firing", async () => {
    mockSql.mockResolvedValueOnce([countRule]);
    mockSql.unsafe.mockResolvedValueOnce([{ matched: 9, session_ids: [] }]);
    // Claim UPDATE returns no rows — another evaluator already stamped
    // last_fired_at inside this window.
    mockSql.mockResolvedValueOnce([]);

    const fired = await evaluateRules();
    expect(fired).toBe(0);
  });

  test("no enabled rules → no work", async () => {
    mockSql.mockResolvedValueOnce([]);
    const fired = await evaluateRules();
    expect(fired).toBe(0);
    expect(mockSql.unsafe).not.toHaveBeenCalled();
  });
});
