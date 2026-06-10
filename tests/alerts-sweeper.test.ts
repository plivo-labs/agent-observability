import { describe, test, expect, mock, beforeEach } from "bun:test";

// Leaf-dependency mocks only — the sweeper exercises the REAL engine and
// deliver modules (bun's module registry is shared across test files, so
// mocking those here would poison the suites that test them directly).
// evaluateRules sees an empty rules list via mockSql; deliveries hit a
// mocked global fetch.

const mockSql: any = mock((..._args: any[]) => Promise.resolve([]));
mockSql.unsafe = mock((..._args: any[]) => Promise.resolve([]));
mockSql.begin = mock((fn: (tx: any) => Promise<unknown>) => fn(mockSql));

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

const mockClaimDueFirings = mock(() => Promise.resolve([] as any[]));
const mockMarkDelivered = mock(() => Promise.resolve());
const mockMarkRetry = mock(() => Promise.resolve());
const mockMarkFailed = mock(() => Promise.resolve());
const mockInsertWebhookAttempt = mock(() => Promise.resolve());

mock.module("../src/alerts/db.js", () => ({
  listAlertRules: mock(() => Promise.resolve({ rules: [], totalCount: 0 })),
  getAlertRule: mock(() => Promise.resolve(null)),
  insertAlertRule: mock((i: any) => Promise.resolve(i)),
  updateAlertRule: mock(() => Promise.resolve(null)),
  deleteAlertRule: mock(() => Promise.resolve(false)),
  listFirings: mock(() => Promise.resolve({ firings: [], totalCount: 0 })),
  listWebhookAttempts: mock(() => Promise.resolve({ attempts: [], totalCount: 0 })),
  getWebhookStats: mock(() => Promise.resolve({})),
  insertWebhookAttempt: mockInsertWebhookAttempt,
  claimDueFirings: mockClaimDueFirings,
  markDelivered: mockMarkDelivered,
  markRetry: mockMarkRetry,
  markFailed: mockMarkFailed,
}));

const { runSweepOnce } = await import("../src/alerts/sweeper.js");
const { MAX_ATTEMPTS } = await import("../src/alerts/deliver.js");

const firing = (overrides: Record<string, unknown> = {}) => ({
  id: "f-1",
  rule_id: "r-1",
  rule_name: "rule",
  metric: "eval_fail_rate",
  judge_name: null,
  threshold_value: 0.2,
  window_minutes: 15,
  agent_id: null,
  account_id: null,
  webhook_url: "https://hooks.example.com/x",
  http_method: "POST",
  secret: null,
  headers: null,
  window_start: "2026-06-10T10:00:00Z",
  window_end: "2026-06-10T10:15:00Z",
  matched_count: 2,
  total_count: 10,
  observed_value: 0.2,
  sample_session_ids: [],
  status: "pending",
  attempt_count: 0,
  created_at: "2026-06-10T10:15:01Z",
  ...overrides,
});

function mockFetchStatus(status: number) {
  globalThis.fetch = mock(async () => new Response("", { status })) as any;
}

describe("alerts/sweeper runSweepOnce", () => {
  beforeEach(() => {
    mockSql.mockClear();
    mockSql.mockImplementation((..._args: any[]) => Promise.resolve([]));
    mockClaimDueFirings.mockClear();
    mockClaimDueFirings.mockImplementation(() => Promise.resolve([]));
    mockMarkDelivered.mockClear();
    mockMarkRetry.mockClear();
    mockMarkFailed.mockClear();
    mockInsertWebhookAttempt.mockClear();
  });

  test("delivers a due firing end to end and marks it delivered", async () => {
    mockFetchStatus(200);
    mockClaimDueFirings.mockResolvedValueOnce([firing()] as any);

    await runSweepOnce();
    expect(mockMarkDelivered).toHaveBeenCalledWith("f-1", 200);
    expect(mockInsertWebhookAttempt).toHaveBeenCalledTimes(1);
    // Rules were evaluated first (empty list via mockSql).
    expect(mockSql).toHaveBeenCalled();
  });

  test("schedules a retry with the first backoff on initial failure", async () => {
    mockFetchStatus(500);
    mockClaimDueFirings.mockResolvedValueOnce([firing()] as any);

    const before = Date.now();
    await runSweepOnce();
    expect(mockMarkRetry).toHaveBeenCalledTimes(1);
    const [id, nextAttemptAt, error, status] = (mockMarkRetry.mock.calls[0] as any[]);
    expect(id).toBe("f-1");
    expect(error).toBe("HTTP 500");
    expect(status).toBe(500);
    const delta = (nextAttemptAt as Date).getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(29_000);
    expect(delta).toBeLessThanOrEqual(35_000);
  });

  test("marks failed once attempts are exhausted", async () => {
    mockFetchStatus(502);
    mockClaimDueFirings.mockResolvedValueOnce([firing({ attempt_count: MAX_ATTEMPTS - 1 })] as any);

    await runSweepOnce();
    expect(mockMarkFailed).toHaveBeenCalledWith("f-1", "HTTP 502", 502);
    expect(mockMarkRetry).not.toHaveBeenCalled();
  });

  test("one bad delivery does not break the batch", async () => {
    let call = 0;
    globalThis.fetch = mock(async () => {
      call++;
      if (call === 1) throw new Error("boom");
      return new Response("", { status: 200 });
    }) as any;
    mockClaimDueFirings.mockResolvedValueOnce([firing(), firing({ id: "f-2" })] as any);

    await runSweepOnce();
    // First firing retries, second delivers.
    expect(mockMarkRetry).toHaveBeenCalledTimes(1);
    expect(mockMarkDelivered).toHaveBeenCalledWith("f-2", 200);
  });

  test("re-entrancy guard: concurrent sweeps collapse into one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Block the first sweep inside evaluateRules' rules query.
    mockSql.mockImplementationOnce(async () => {
      await gate;
      return [];
    });

    const first = runSweepOnce();
    await runSweepOnce(); // returns immediately — guard active
    expect(mockClaimDueFirings).not.toHaveBeenCalled();
    release();
    await first;
    expect(mockClaimDueFirings).toHaveBeenCalledTimes(1);
  });
});
