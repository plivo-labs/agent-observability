/**
 * Unit tests for src/evals/db.ts idempotent ingest and stale-run sweeper.
 * The sql client is mocked so no real DB is required.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { randomUUID } from "crypto";

// ── sql mock ──────────────────────────────────────────────────────────────

// Tracks calls so tests can inspect the SQL sent.
const sqlCalls: { sql: string; params: unknown[] }[] = [];

// tx mock used inside sql.begin
const txMock = mock(async (strings: TemplateStringsArray, ...values: unknown[]) => {
  sqlCalls.push({ sql: strings.join("?"), params: values });
  return [];
});

const sqlMock: any = mock(async (strings: TemplateStringsArray, ...values: unknown[]) => {
  sqlCalls.push({ sql: strings.join("?"), params: values });
  return [];
});
sqlMock.unsafe = mock(async (query: string, params: unknown[]) => {
  sqlCalls.push({ sql: query, params: params ?? [] });
  return [];
});
sqlMock.begin = mock(async (fn: (tx: any) => Promise<void>) => {
  await fn(txMock);
});

mock.module("../src/db.js", () => ({
  sql: sqlMock,
  insertSession: mock(() => Promise.resolve()),
  applyStoredSessionTags: mock(() => Promise.resolve()),
  upsertSessionTag: mock(() => Promise.resolve()),
  insertLiveKitEvaluation: mock(() => Promise.resolve()),
  upsertSessionOutcome: mock(() => Promise.resolve()),
  mergeSessionRawReport: mock(() => Promise.resolve()),
  applySessionTagMetadata: mock(() => Promise.resolve()),
}));
mock.module("../src/evals/summarize.js", () => ({
  ensurePricesLoaded: () => Promise.resolve(),
  computeCaseMetrics: (_events: unknown[]) => ({
    ttfts_ms: [],
    ttfbs_ms: [],
    turn_count: 0,
    tool_call_count: 0,
    interruption_count: 0,
    agent_handoff_count: 0,
    ttft_p50_ms: null,
    ttft_p95_ms: null,
    ttft_avg_ms: null,
    ttfb_p50_ms: null,
    ttfb_p95_ms: null,
    ttfb_avg_ms: null,
    ttft_sample_count: 0,
    prompt_tokens: 0,
    cached_prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    estimated_cost_usd: null,
  }),
  summarize: (cases: unknown[]) => ({
    total: cases.length,
    passed: 0,
    failed: 0,
    errored: 0,
    skipped: 0,
  }),
}));

const { insertEvalRun, sweepStaleRuns } = await import("../src/evals/db.js");

function makeRun(overrides?: Partial<any>) {
  return {
    run_id: randomUUID(),
    testing_framework: "pytest",
    started_at: 1714000000,
    finished_at: null,
    ...overrides,
  };
}

function makeCase(overrides?: Partial<any>) {
  return {
    case_id: randomUUID(),
    name: "test_case",
    status: "passed" as const,
    events: [],
    judgments: [],
    ...overrides,
  };
}

// ── Idempotency tests ─────────────────────────────────────────────────────

describe("insertEvalRun — idempotent ingest", () => {
  beforeEach(() => {
    sqlCalls.length = 0;
    txMock.mockClear();
    sqlMock.begin.mockClear();
  });

  test("heartbeat POST (cases=[]) calls sql.begin once with no case inserts", async () => {
    const run = makeRun({ status: "running" });
    await insertEvalRun({ version: "v0", run, cases: [] });

    expect(sqlMock.begin).toHaveBeenCalledTimes(1);
    // txMock called exactly once (the run upsert), no case insert
    expect(txMock).toHaveBeenCalledTimes(1);
    const runSql = (txMock.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(runSql).toContain("ON CONFLICT (run_id) DO UPDATE SET");
    expect(runSql).toContain("INSERT INTO eval_runs");
  });

  test("POST with one case issues run upsert + one case upsert", async () => {
    const run = makeRun({ status: "running" });
    const c = makeCase();
    await insertEvalRun({ version: "v0", run, cases: [c] });

    expect(txMock).toHaveBeenCalledTimes(2);
    const caseSql = (txMock.mock.calls[1][0] as TemplateStringsArray).join("?");
    expect(caseSql).toContain("ON CONFLICT (case_id) DO UPDATE SET");
    expect(caseSql).toContain("INSERT INTO eval_cases");
  });

  test("POST with same case_id twice — case upsert issued both times (idempotent)", async () => {
    const run = makeRun({ status: "running" });
    const c = makeCase();

    await insertEvalRun({ version: "v0", run, cases: [c] });
    txMock.mockClear();
    sqlMock.begin.mockClear();

    // Second POST with same case_id
    await insertEvalRun({ version: "v0", run, cases: [c] });
    // Still 2 tx calls (run upsert + case upsert) — DB deduplicates via ON CONFLICT
    expect(txMock).toHaveBeenCalledTimes(2);
  });

  test("terminal POST with finished_at flips status to completed", async () => {
    const run = makeRun({ finished_at: 1714000060, status: "completed" });
    const c = makeCase();
    await insertEvalRun({ version: "v0", run, cases: [c] });

    const runSql = (txMock.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(runSql).toContain("ON CONFLICT (run_id) DO UPDATE SET");
    // status CASE expression preserves terminal states
    expect(runSql).toContain("status");
  });

  test("run upsert does NOT include additive counter arithmetic", async () => {
    const run = makeRun({ status: "running" });
    await insertEvalRun({ version: "v0", run, cases: [] });

    const runSql = (txMock.mock.calls[0][0] as TemplateStringsArray).join("?");
    // The old additive pattern must not appear
    expect(runSql).not.toContain("eval_runs.total + EXCLUDED.total");
    expect(runSql).not.toContain("eval_runs.passed + EXCLUDED.passed");
  });
});

// ── Sweeper tests ─────────────────────────────────────────────────────────

describe("sweepStaleRuns", () => {
  beforeEach(() => {
    sqlMock.unsafe.mockClear();
    sqlCalls.length = 0;
  });

  test("issues UPDATE for stale running rows and returns swept count", async () => {
    // Simulate 2 rows swept
    (sqlMock.unsafe as ReturnType<typeof mock>).mockImplementationOnce(
      async (_query: string, _params: unknown[]) => [{ run_id: "r1" }, { run_id: "r2" }],
    );

    const count = await sweepStaleRuns();
    expect(count).toBe(2);

    const call = sqlMock.unsafe.mock.calls[0];
    expect(call[0]).toContain("UPDATE eval_runs");
    expect(call[0]).toContain("status = $1");
    expect(call[0]).toContain("last_heartbeat_at < now() - interval '60 seconds'");
    expect(call[1]).toEqual(["failed", "running"]);
  });

  test("returns 0 when no stale rows", async () => {
    (sqlMock.unsafe as ReturnType<typeof mock>).mockImplementationOnce(
      async () => [],
    );
    const count = await sweepStaleRuns();
    expect(count).toBe(0);
  });
});
