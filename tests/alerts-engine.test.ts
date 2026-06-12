import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockSql: any = mock((..._args: any[]) => Promise.resolve([]));
// Metric queries now run via runMetricQuery, which issues a transparent
// `SET LOCAL statement_timeout` before the real query (COR-04). The mock
// short-circuits that statement and pulls the actual metric response from
// a FIFO queue the tests control, so the timeout plumbing doesn't perturb
// the response sequencing.
let metricQueue: Array<any[] | Error> = [];
mockSql.unsafe = mock((q: any, ..._rest: any[]) => {
  if (typeof q === "string" && q.trimStart().startsWith("SET LOCAL")) {
    return Promise.resolve([]);
  }
  const next = metricQueue.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? []);
});
mockSql.begin = mock((fn: (tx: any) => Promise<unknown>) => fn(mockSql));

/** The real (non-SET-LOCAL) metric queries issued this test, in order. */
function metricCalls(): any[][] {
  return mockSql.unsafe.mock.calls.filter(
    (c: any[]) => !(typeof c[0] === "string" && c[0].trimStart().startsWith("SET LOCAL")),
  );
}

// Full export surface: the first mock of a module fixes its export shape
// for the rest of the bun test run, and routes tests import names beyond
// `sql` from this module.
mock.module("../src/db.js", () => ({
  sql: mockSql,
  insertSession: mock(() => Promise.resolve()),
  applyStoredSessionTags: mock(() => Promise.resolve()),
  drainStagedRawReportPatches: mock(() => Promise.resolve()),
  upsertSessionTag: mock(() => Promise.resolve()),
  insertLiveKitEvaluation: mock(() => Promise.resolve()),
  upsertSessionOutcome: mock(() => Promise.resolve()),
  applySessionTagMetadata: mock(() => Promise.resolve()),
  mergeSessionRawReport: mock(() => Promise.resolve()),
}));

const { evaluateRules } = await import("../src/alerts/engine.js");

const failRateRule = {
  id: "r2",
  metric: "eval_fail_rate",
  judge_name: "task_completion",
  threshold_value: 0.2,
  min_samples: 5,
  window_minutes: 60,
  agent_id: null,
  account_id: null,
};

const latencyRule = {
  ...failRateRule,
  id: "r4",
  metric: "latency_perceived_p95",
  threshold_value: 2000,
  min_samples: 10,
};


describe("alerts/engine evaluateRules", () => {
  beforeEach(() => {
    mockSql.mockClear();
    mockSql.unsafe.mockClear();
    mockSql.begin.mockClear();
    metricQueue = [];
    mockSql.mockImplementation((..._args: any[]) => Promise.resolve([]));
  });

  test("eval_fail_rate fires above the threshold and stamps last_fired_at in a transaction", async () => {
    mockSql.mockResolvedValueOnce([failRateRule]); // rules list
    metricQueue.push([{ total: 10, matched: 4, session_ids: ["s-9"] }]);
    mockSql.mockResolvedValueOnce([{ id: "r2" }]); // suppression claim succeeds

    const fired = await evaluateRules();
    expect(fired).toBe(1); // 0.4 > 0.2 with 10 ≥ 5 samples
    expect(mockSql.begin).toHaveBeenCalledTimes(2); // timeout tx + firing tx
    // Window query received the interval + judge filter.
    const params = metricCalls()[0][1];
    expect(params[0]).toBe("60");
    expect(params[1]).toBe("task_completion");
  });

  test("eval_fail_rate stays quiet under min_samples", async () => {
    mockSql.mockResolvedValueOnce([failRateRule]);
    metricQueue.push([{ total: 3, matched: 3, session_ids: [] }]);

    const fired = await evaluateRules();
    expect(fired).toBe(0); // 100% fail but only 3 of 5 required samples
  });

  test("eval_fail_rate stays quiet at or below the threshold", async () => {
    mockSql.mockResolvedValueOnce([failRateRule]);
    metricQueue.push([{ total: 10, matched: 2, session_ids: [] }]);

    const fired = await evaluateRules();
    expect(fired).toBe(0); // 0.2 is not > 0.2
  });

  test("latency p95 fires above the ms threshold", async () => {
    mockSql.mockResolvedValueOnce([latencyRule]);
    metricQueue.push([{ samples: 40, p95: 2600, session_ids: ["s-1"] }]);
    mockSql.mockResolvedValueOnce([{ id: "r4" }]); // suppression claim

    const fired = await evaluateRules();
    expect(fired).toBe(1); // 2600ms > 2000ms with 40 ≥ 10 samples
  });

  test("latency p95 stays quiet under min_samples", async () => {
    mockSql.mockResolvedValueOnce([latencyRule]);
    metricQueue.push([{ samples: 4, p95: 9000, session_ids: [] }]);

    const fired = await evaluateRules();
    expect(fired).toBe(0);
  });



  test("a failing rule does not block the others", async () => {
    mockSql.mockResolvedValueOnce([failRateRule, { ...failRateRule, id: "r3" }]);
    metricQueue.push(new Error("boom"), [{ total: 10, matched: 9, session_ids: [] }]);
    mockSql.mockResolvedValueOnce([{ id: "r3" }]); // suppression claim for r3

    const fired = await evaluateRules();
    expect(fired).toBe(1);
  });

  test("a lost suppression claim does not count as a firing", async () => {
    mockSql.mockResolvedValueOnce([failRateRule]);
    metricQueue.push([{ total: 10, matched: 9, session_ids: [] }]);
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
