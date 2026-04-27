import { describe, test, expect, mock, beforeEach } from "bun:test";
import { randomUUID } from "crypto";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockInsertEvalRun = mock((_payload: any) => Promise.resolve());
const mockCountEvalRuns = mock((_opts: any) => Promise.resolve(0));
const mockListEvalRuns = mock((_opts: any) => Promise.resolve([] as any[]));
const mockGetEvalRun = mock((_runId: string) => Promise.resolve(null as any));
const mockListEvalCases = mock((_runId: string) => Promise.resolve([] as any[]));
const mockGetEvalCase = mock((_runId: string, _caseId: string) =>
  Promise.resolve(null as any),
);

const mockSql: any = mock((..._args: any[]) => Promise.resolve([]));
mockSql.unsafe = mockSql;

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";

mock.module("../src/config.js", () => ({
  config: {
    PORT: 9090,
    AGENT_OBSERVABILITY_USER: TEST_USER,
    AGENT_OBSERVABILITY_PASS: TEST_PASS,
    AUTO_MIGRATE: false,
    DATABASE_URL: "postgres://localhost:5432/test",
    S3_REGION: "us-east-1",
    S3_PREFIX: "recordings",
  },
  s3Enabled: false,
  basicAuthEnabled: true,
}));

mock.module("../src/db.js", () => ({
  sql: mockSql,
  insertSession: mock(() => Promise.resolve()),
}));

mock.module("../src/evals/db.js", () => ({
  insertEvalRun: mockInsertEvalRun,
  countEvalRuns: mockCountEvalRuns,
  listEvalRuns: mockListEvalRuns,
  getEvalRun: mockGetEvalRun,
  listEvalCases: mockListEvalCases,
  getEvalCase: mockGetEvalCase,
}));

mock.module("../src/migrate.js", () => ({
  migrate: () => Promise.resolve(),
}));

mock.module("../src/s3.js", () => ({
  uploadRecording: () => Promise.resolve("https://s3.example.com/recording.ogg"),
}));

const { default: server } = await import("../src/index.js");

function basicAuthHeader(): string {
  return `Basic ${Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString("base64")}`;
}

function makeRequest(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:9090${path}`, init);
}

function buildValidPayload(overrides?: {
  cases?: any[];
  run?: Partial<any>;
}) {
  const runId = randomUUID();
  return {
    version: "v0",
    run: {
      run_id: runId,
      account_id: "acct-1",
      agent_id: "support-bot",
      framework: "livekit",
      framework_version: "1.5.2",
      testing_framework: "pytest",
      testing_framework_version: "8.3.0",
      started_at: 1714000000,
      finished_at: 1714000060,
      ci: {
        provider: "github",
        run_url: "https://github.com/example/runs/1",
        git_sha: "abc123",
      },
      ...(overrides?.run ?? {}),
    },
    cases: overrides?.cases ?? [
      {
        case_id: randomUUID(),
        name: "test_greeting_offers_help",
        file: "tests/test_assistant.py",
        status: "passed",
        duration_ms: 4800,
        user_input: "Hello",
        events: [
          { type: "message", role: "assistant", content: "Hi! How can I help?" },
        ],
        judgments: [
          { intent: "greets politely", verdict: "pass", reasoning: "ok" },
        ],
      },
      {
        case_id: randomUUID(),
        name: "test_refuses_harmful",
        file: "tests/test_safety.py",
        status: "failed",
        duration_ms: 2100,
        user_input: "Bad thing",
        events: [
          {
            type: "function_call",
            name: "lookup_order",
            arguments: { order_id: "x" },
          },
        ],
        judgments: [
          { intent: "refuses harmful", verdict: "fail", reasoning: "complied" },
        ],
        failure: {
          kind: "judge_failed",
          message: "verdict=fail",
        },
      },
    ],
  };
}

// ── POST /observability/evals/v0 ────────────────────────────────────────────

describe("POST /observability/evals/v0", () => {
  beforeEach(() => {
    mockInsertEvalRun.mockClear();
  });

  test("rejects request without auth", async () => {
    const res = await server.fetch(
      makeRequest("/observability/evals/v0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildValidPayload()),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("rejects non-JSON body with 400", async () => {
    const res = await server.fetch(
      makeRequest("/observability/evals/v0", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: basicAuthHeader(),
        },
        body: "not-json",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
  });

  test("rejects payload missing version", async () => {
    const payload = buildValidPayload();
    delete (payload as any).version;
    const res = await server.fetch(
      makeRequest("/observability/evals/v0", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: basicAuthHeader(),
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_payload");
  });

  test("rejects invalid case status", async () => {
    const payload = buildValidPayload({
      cases: [
        {
          case_id: randomUUID(),
          name: "x",
          status: "bogus",
          events: [],
          judgments: [],
        },
      ],
    });
    const res = await server.fetch(
      makeRequest("/observability/evals/v0", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: basicAuthHeader(),
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_payload");
  });

  test("accepts valid payload and calls insertEvalRun", async () => {
    const payload = buildValidPayload();
    const res = await server.fetch(
      makeRequest("/observability/evals/v0", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: basicAuthHeader(),
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.run_id).toBe(payload.run.run_id);
    expect(body.case_count).toBe(2);
    expect(mockInsertEvalRun).toHaveBeenCalledTimes(1);
    const called = mockInsertEvalRun.mock.calls[0][0];
    expect(called.run.run_id).toBe(payload.run.run_id);
    expect(called.cases).toHaveLength(2);
  });

  test("translates legacy payload (framework=vitest, sdk=livekit-agents)", async () => {
    // Plugins ≤ 0.1.x sent the legacy shape. The schema preprocess
    // step should remap onto the new fields and normalize the SDK
    // package name to the canonical agent-framework family.
    const legacy = buildValidPayload();
    delete (legacy.run as any).framework;
    delete (legacy.run as any).framework_version;
    delete (legacy.run as any).testing_framework;
    delete (legacy.run as any).testing_framework_version;
    Object.assign(legacy.run, {
      framework: "vitest",
      framework_version: "2.1.9",
      sdk: "livekit-agents",
      sdk_version: "1.2.8",
    });

    const res = await server.fetch(
      makeRequest("/observability/evals/v0", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: basicAuthHeader(),
        },
        body: JSON.stringify(legacy),
      }),
    );
    expect(res.status).toBe(201);
    expect(mockInsertEvalRun).toHaveBeenCalledTimes(1);
    const called = mockInsertEvalRun.mock.calls[0][0];
    expect(called.run.framework).toBe("livekit");
    expect(called.run.framework_version).toBe("1.2.8");
    expect(called.run.testing_framework).toBe("vitest");
    expect(called.run.testing_framework_version).toBe("2.1.9");
    // Legacy keys must not leak through.
    expect((called.run as any).sdk).toBeUndefined();
    expect((called.run as any).sdk_version).toBeUndefined();
  });

  test("returns 500 when insert fails", async () => {
    mockInsertEvalRun.mockImplementationOnce(() =>
      Promise.reject(new Error("db down")),
    );
    const res = await server.fetch(
      makeRequest("/observability/evals/v0", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: basicAuthHeader(),
        },
        body: JSON.stringify(buildValidPayload()),
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("db_error");
  });
});

// ── GET /api/evals ──────────────────────────────────────────────────────────

describe("GET /api/evals", () => {
  beforeEach(() => {
    mockCountEvalRuns.mockClear();
    mockListEvalRuns.mockClear();
  });

  test("rejects without auth", async () => {
    const res = await server.fetch(makeRequest("/api/evals"));
    expect(res.status).toBe(401);
  });

  test("returns paginated list with defaults", async () => {
    mockCountEvalRuns.mockResolvedValueOnce(2 as any);
    mockListEvalRuns.mockResolvedValueOnce([
      { run_id: "r1", agent_id: "a", framework: "pytest", total: 3, passed: 3 },
      { run_id: "r2", agent_id: "a", framework: "pytest", total: 5, passed: 4 },
    ] as any);

    const res = await server.fetch(
      makeRequest("/api/evals", { headers: { Authorization: basicAuthHeader() } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.limit).toBe(20);
    expect(body.meta.offset).toBe(0);
    expect(body.meta.total_count).toBe(2);
    expect(body.objects).toHaveLength(2);
  });

  test("clamps limit to 20", async () => {
    mockCountEvalRuns.mockResolvedValueOnce(0 as any);
    mockListEvalRuns.mockResolvedValueOnce([] as any);

    const res = await server.fetch(
      makeRequest("/api/evals?limit=999", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.limit).toBe(20);
  });

  test("forwards filters to db opts", async () => {
    mockCountEvalRuns.mockResolvedValueOnce(0 as any);
    mockListEvalRuns.mockResolvedValueOnce([] as any);

    const res = await server.fetch(
      makeRequest(
        "/api/evals?agent_id=support-bot&framework=livekit&testing_framework=pytest&account_id=acct-1",
        { headers: { Authorization: basicAuthHeader() } },
      ),
    );
    expect(res.status).toBe(200);
    const opts = mockListEvalRuns.mock.calls[0][0];
    expect(opts.agentId).toBe("support-bot");
    expect(opts.frameworks).toEqual(["livekit"]);
    expect(opts.testingFrameworks).toEqual(["pytest"]);
    expect(opts.accountId).toBe("acct-1");
  });

  test("accepts multi-value framework filter (comma-separated)", async () => {
    mockCountEvalRuns.mockResolvedValueOnce(0 as any);
    mockListEvalRuns.mockResolvedValueOnce([] as any);

    const res = await server.fetch(
      makeRequest("/api/evals?framework=livekit,pipecat", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(200);
    const opts = mockListEvalRuns.mock.calls[0][0];
    expect(opts.frameworks).toEqual(["livekit", "pipecat"]);
  });

  test("accepts multi-value testing_framework filter (comma-separated)", async () => {
    mockCountEvalRuns.mockResolvedValueOnce(0 as any);
    mockListEvalRuns.mockResolvedValueOnce([] as any);

    const res = await server.fetch(
      makeRequest("/api/evals?testing_framework=pytest,vitest", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(200);
    const opts = mockListEvalRuns.mock.calls[0][0];
    expect(opts.testingFrameworks).toEqual(["pytest", "vitest"]);
  });

  test("pagination links preserve filters", async () => {
    mockCountEvalRuns.mockResolvedValueOnce(30 as any);
    mockListEvalRuns.mockResolvedValueOnce([] as any);

    const res = await server.fetch(
      makeRequest("/api/evals?limit=10&offset=10&agent_id=support-bot", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.next).toContain("agent_id=support-bot");
    expect(body.meta.next).toContain("offset=20");
    expect(body.meta.previous).toContain("agent_id=support-bot");
  });
});

// ── GET /api/evals/:run_id ──────────────────────────────────────────────────

describe("GET /api/evals/:run_id", () => {
  beforeEach(() => {
    mockGetEvalRun.mockClear();
    mockListEvalCases.mockClear();
  });

  test("returns run + cases", async () => {
    mockGetEvalRun.mockResolvedValueOnce({
      run_id: "r1",
      agent_id: "support-bot",
      framework: "pytest",
      total: 2,
      passed: 1,
      failed: 1,
      errored: 0,
      skipped: 0,
    } as any);
    mockListEvalCases.mockResolvedValueOnce([
      { case_id: "c1", name: "ok", status: "passed", events: [], judgments: [] },
      { case_id: "c2", name: "bad", status: "failed", events: [], judgments: [] },
    ] as any);

    const res = await server.fetch(
      makeRequest("/api/evals/r1", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run_id).toBe("r1");
    expect(body.cases).toHaveLength(2);
  });

  test("returns 404 when run not found", async () => {
    mockGetEvalRun.mockResolvedValueOnce(null);
    const res = await server.fetch(
      makeRequest("/api/evals/nope", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });
});

// ── GET /api/evals/:run_id/cases/:case_id ───────────────────────────────────

describe("GET /api/evals/:run_id/cases/:case_id", () => {
  beforeEach(() => {
    mockGetEvalCase.mockClear();
  });

  test("returns case", async () => {
    mockGetEvalCase.mockResolvedValueOnce({
      case_id: "c1",
      run_id: "r1",
      name: "ok",
      status: "passed",
      events: [],
      judgments: [],
    } as any);
    const res = await server.fetch(
      makeRequest("/api/evals/r1/cases/c1", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.case_id).toBe("c1");
    expect(body.name).toBe("ok");
  });

  test("returns 404 when case not found", async () => {
    mockGetEvalCase.mockResolvedValueOnce(null);
    const res = await server.fetch(
      makeRequest("/api/evals/r1/cases/nope", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });
});

