import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockSql: any = mock((..._args: any[]) => Promise.resolve([]));
mockSql.unsafe = mock((_query: string, _params: unknown[]) => Promise.resolve([]));

mock.module("../src/db.js", () => ({
  sql: mockSql,
  insertSession: mock(() => Promise.resolve()),
  applyStoredSessionTags: mock(() => Promise.resolve()),
  upsertSessionTag: mock(() => Promise.resolve()),
  insertLiveKitEvaluation: mock(() => Promise.resolve()),
  upsertSessionOutcome: mock(() => Promise.resolve()),
  mergeSessionRawReport: mock(() => Promise.resolve()),
  applySessionTagMetadata: mock(() => Promise.resolve()),
}));

const query = await import("../src/evals/query.js");

describe("eval query status overlay", () => {
  beforeEach(() => {
    mockSql.unsafe.mockClear();
  });

  test("marks running run as failed when stale heartbeat", async () => {
    mockSql.unsafe.mockResolvedValueOnce([
      {
        run_id: "r1",
        status: "running",
        last_heartbeat_at: new Date(Date.now() - 120_000).toISOString(),
      },
    ] as any);

    const rows = await query.listEvalRuns({ limit: 20, offset: 0 });
    expect(rows[0].status).toBe("failed");
  });

  test("marks queued/running with finished_at as completed", async () => {
    mockSql.unsafe.mockResolvedValueOnce([
      {
        run_id: "r2",
        status: "queued",
        finished_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
      },
    ] as any);

    const row = await query.getEvalRun("r2");
    expect(row.status).toBe("completed");
  });

  test("keeps terminal status unchanged", async () => {
    mockSql.unsafe.mockResolvedValueOnce([
      {
        run_id: "r3",
        status: "cancelled",
        finished_at: null,
        last_heartbeat_at: new Date(Date.now() - 120_000).toISOString(),
      },
    ] as any);

    const row = await query.getEvalRun("r3");
    expect(row.status).toBe("cancelled");
  });

  test("coerces case numeric fields for case detail", async () => {
    mockSql.unsafe.mockResolvedValueOnce([
      {
        run_id: "r1",
        case_id: "c1",
        status: "passed",
        events: "[]",
        judgments: "[]",
        failure: null,
        duration_ms: "42",
        total_tokens: "13",
        prompt_tokens: "5",
      },
    ] as any);

    const row = await query.getEvalCase("r1", "c1");
    expect(row.duration_ms).toBe(42);
    expect(row.total_tokens).toBe(13);
    expect(row.prompt_tokens).toBe(5);
  });
});
