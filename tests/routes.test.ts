import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock side-effectful modules before importing the app ────────────────────

const mockInsertSession = mock(() => Promise.resolve());
const mockSql: any = mock((..._args: any[]) => Promise.resolve([]));
// Route `sql.unsafe(...)` through the same queue as `sql\`...\`` so the
// existing `.mockResolvedValueOnce(...)` pattern works for both call styles.
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
  insertSession: mockInsertSession,
}));

mock.module("../src/migrate.js", () => ({
  migrate: () => Promise.resolve(),
}));

mock.module("../src/s3.js", () => ({
  uploadRecording: () => Promise.resolve("https://s3.example.com/recording.ogg"),
}));

// Import app after mocks are set up
const { default: server } = await import("../src/index.js");

function basicAuthHeader(): string {
  return `Basic ${Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString("base64")}`;
}

function makeRequest(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:9090${path}`, init);
}

// ── Health check ────────────────────────────────────────────────────────────

describe("GET /health", () => {
  test("returns status ok without auth", async () => {
    const res = await server.fetch(makeRequest("/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.s3Enabled).toBe(false);
  });
});

// ── Session report endpoint ─────────────────────────────────────────────────

describe("POST /observability/recordings/v0", () => {
  beforeEach(() => {
    mockInsertSession.mockClear();
  });

  test("rejects request without auth header", async () => {
    const form = new FormData();
    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        body: form,
      })
    );
    expect(res.status).toBe(401);
  });

  test("rejects request with wrong credentials", async () => {
    const form = new FormData();
    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from("wrong:creds").toString("base64")}` },
        body: form,
      })
    );
    expect(res.status).toBe(401);
  });

  test("accepts valid request and calls insertSession", async () => {
    const chatHistory = JSON.stringify({
      items: [
        { id: "m1", type: "message", role: "user", metrics: { transcription_delay: 0.12 } },
        { id: "m2", type: "message", role: "assistant", metrics: { llm_node_ttft: 0.4, tts_node_ttfb: 0.08 } },
      ],
    });

    const form = new FormData();
    form.append("chat_history", new Blob([chatHistory], { type: "application/json" }));

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: basicAuthHeader() },
        body: form,
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.api_id).toBeDefined();
    expect(body.message).toBe("session report received");

    // Verify insertSession was called with parsed data
    expect(mockInsertSession).toHaveBeenCalledTimes(1);
    const call = mockInsertSession.mock.calls[0][0] as any;
    expect(call.turnCount).toBe(2);
    expect(call.hasStt).toBe(true);
    expect(call.hasLlm).toBe(true);
    expect(call.hasTts).toBe(true);
    expect(call.chatHistory).toHaveLength(2);
    expect(call.sessionMetrics.per_turn).toHaveLength(2);
    expect(call.sessionMetrics.usage).toBeNull();
  });

  test("parses JSON header with session_id and account_id", async () => {
    const headerJson = JSON.stringify({
      session_id: "sess-123",
      room_tags: { account_id: "acct-456" },
      start_time: 1700000000,
    });

    const form = new FormData();
    form.append("header", new Blob([headerJson], { type: "application/json" }));

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: basicAuthHeader() },
        body: form,
      })
    );

    expect(res.status).toBe(200);
    expect(mockInsertSession).toHaveBeenCalledTimes(1);
    const call = mockInsertSession.mock.calls[0][0] as any;
    expect(call.sessionId).toBe("sess-123");
    expect(call.accountId).toBe("acct-456");
    expect(call.startedAt).toBeInstanceOf(Date);
    expect(call.transport).toBeNull();
  });

  test("parses transport field from header", async () => {
    const headerJson = JSON.stringify({
      session_id: "sess-sip",
      room_tags: { account_id: "acct-1" },
      start_time: 1700000000,
      transport: "sip",
    });

    const form = new FormData();
    form.append("header", new Blob([headerJson], { type: "application/json" }));

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: basicAuthHeader() },
        body: form,
      })
    );

    expect(res.status).toBe(200);
    expect(mockInsertSession).toHaveBeenCalledTimes(1);
    const call = mockInsertSession.mock.calls[0][0] as any;
    expect(call.transport).toBe("sip");
  });

  test("parses transport=audio_stream from header", async () => {
    const headerJson = JSON.stringify({
      session_id: "sess-as",
      room_tags: {},
      start_time: 0,
      transport: "audio_stream",
    });

    const form = new FormData();
    form.append("header", new Blob([headerJson], { type: "application/json" }));

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: basicAuthHeader() },
        body: form,
      })
    );

    expect(res.status).toBe(200);
    expect(mockInsertSession).toHaveBeenCalledTimes(1);
    const call = mockInsertSession.mock.calls[0][0] as any;
    expect(call.transport).toBe("audio_stream");
  });

  test("handles request with no chat history", async () => {
    const form = new FormData();

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: basicAuthHeader() },
        body: form,
      })
    );

    expect(res.status).toBe(200);
    expect(mockInsertSession).toHaveBeenCalledTimes(1);
    const call = mockInsertSession.mock.calls[0][0] as any;
    expect(call.turnCount).toBe(0);
    expect(call.hasStt).toBe(false);
    expect(call.hasLlm).toBe(false);
    expect(call.hasTts).toBe(false);
    expect(call.chatHistory).toEqual([]);
  });

  test("still returns ok when insertSession fails", async () => {
    mockInsertSession.mockImplementationOnce(() => Promise.reject(new Error("db down")));

    const form = new FormData();

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: basicAuthHeader() },
        body: form,
      })
    );

    expect(res.status).toBe(200);
    expect(mockInsertSession).toHaveBeenCalledTimes(1);
  });

  test("handles malformed chat history JSON gracefully", async () => {
    const form = new FormData();
    form.append("chat_history", new Blob(["not valid json"], { type: "application/json" }));

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: basicAuthHeader() },
        body: form,
      })
    );

    expect(res.status).toBe(200);
    expect(mockInsertSession).toHaveBeenCalledTimes(1);
    const call = mockInsertSession.mock.calls[0][0] as any;
    expect(call.turnCount).toBe(0);
    expect(call.chatHistory).toEqual([]);
  });
});

// ── Dashboard API: GET /api/sessions ────────────────────────────────────────

describe("GET /api/sessions", () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  test("rejects request without auth", async () => {
    const res = await server.fetch(makeRequest("/api/sessions"));
    expect(res.status).toBe(401);
  });

  test("returns paginated sessions list", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 2 }])
      .mockResolvedValueOnce([
        { id: 1, session_id: "sess-1", turn_count: 3, created_at: "2025-01-01" },
        { id: 2, session_id: "sess-2", turn_count: 5, created_at: "2025-01-02" },
      ]);

    const res = await server.fetch(
      makeRequest("/api/sessions?limit=10&offset=0", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.api_id).toBeDefined();
    expect(body.meta.total_count).toBe(2);
    expect(body.objects).toHaveLength(2);
    expect(body.meta.limit).toBe(10);
    expect(body.meta.offset).toBe(0);
    expect(body.meta.next).toBeNull();
    expect(body.meta.previous).toBeNull();
  });

  test("applies default pagination", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.offset).toBe(0);
    expect(body.meta.limit).toBe(20);
  });

  test("clamps limit to 20", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?limit=999", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.limit).toBe(20);
  });

  test("clamps offset minimum to 0", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?offset=-5", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.offset).toBe(0);
  });

  test("includes next/previous pagination links", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 30 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?limit=10&offset=10", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.next).toContain("offset=20");
    expect(body.meta.previous).toContain("offset=0");
  });

  test("passes account_id filter as a WHERE predicate", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?account_id=acct-xyz", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    // Count + rows = 2 SQL calls; both must include the WHERE clause and the param.
    expect(mockSql).toHaveBeenCalledTimes(2);
    const [countQuery, countParams] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(countQuery).toContain("WHERE account_id =");
    expect(countParams).toEqual(["acct-xyz"]);
    const [rowsQuery, rowsParams] = mockSql.mock.calls[1] as [string, unknown[]];
    expect(rowsQuery).toContain("WHERE account_id =");
    expect(rowsParams).toEqual(["acct-xyz", 20, 0]);
  });

  test("passes started_from/started_to filters as timestamp predicates", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const from = "2026-04-01T00:00:00.000Z";
    const to = "2026-04-30T23:59:59.999Z";
    const res = await server.fetch(
      makeRequest(`/api/sessions?started_from=${encodeURIComponent(from)}&started_to=${encodeURIComponent(to)}`, {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    expect(mockSql).toHaveBeenCalledTimes(2);
    const [countQuery, countParams] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(countQuery).toContain("started_at >=");
    expect(countQuery).toContain("started_at <=");
    expect(countParams).toEqual([from, to]);
  });

  test("combines account_id + date range into a single WHERE clause", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const from = "2026-04-01T00:00:00.000Z";
    const to = "2026-04-30T23:59:59.999Z";
    const res = await server.fetch(
      makeRequest(
        `/api/sessions?account_id=acct-1&started_from=${encodeURIComponent(from)}&started_to=${encodeURIComponent(to)}`,
        { headers: { Authorization: basicAuthHeader() } },
      )
    );
    expect(res.status).toBe(200);

    const [countQuery, countParams] = mockSql.mock.calls[0] as [string, unknown[]];
    // All three predicates present, joined with AND.
    expect(countQuery).toMatch(/account_id = \$1.*AND.*started_at >= \$2.*AND.*started_at <= \$3/s);
    expect(countParams).toEqual(["acct-1", from, to]);
  });

  test("omits WHERE clause entirely when no filters are active", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    const [countQuery, countParams] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(countQuery).not.toContain("WHERE");
    expect(countParams).toEqual([]);
  });

  test("pagination links preserve active filters", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 30 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?limit=10&offset=10&account_id=acct-1&started_from=2026-04-01", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.next).toContain("account_id=acct-1");
    expect(body.meta.next).toContain("started_from=2026-04-01");
    expect(body.meta.next).toContain("offset=20");
    expect(body.meta.previous).toContain("account_id=acct-1");
    expect(body.meta.previous).toContain("offset=0");
  });
});

// ── Dashboard API: GET /api/sessions/:id ────────────────────────────────────

describe("GET /api/sessions/:id", () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  test("returns session detail with computed metrics", async () => {
    const chatHistory = [
      { id: "u1", type: "message", role: "user", content: "hi", metrics: { transcription_delay: 0.1 } },
      { id: "a1", type: "message", role: "assistant", content: "hello", metrics: { llm_node_ttft: 0.3, tts_node_ttfb: 0.05 } },
    ];
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        session_id: "sess-1",
        turn_count: 1,
        chat_history: JSON.stringify(chatHistory),
        session_metrics: JSON.stringify({ per_turn: [], usage: null }),
      },
    ]);

    const res = await server.fetch(
      makeRequest("/api/sessions/sess-1", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.api_id).toBeDefined();
    expect(body.session_id).toBe("sess-1");
    expect(body.chat_history).toBeInstanceOf(Array);
    expect(body.session_metrics).toBeDefined();
    expect(body.session_metrics.turns).toHaveLength(1);
    expect(body.session_metrics.turns[0].llm_ttft_ms).toBe(300);
    expect(body.session_metrics.summary.total_turns).toBe(1);
  });

  test("handles already-parsed JSONB fields", async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        session_id: "sess-2",
        turn_count: 0,
        chat_history: [{ id: "m1" }],
        session_metrics: { per_turn: [], usage: null },
      },
    ]);

    const res = await server.fetch(
      makeRequest("/api/sessions/sess-2", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chat_history).toBeInstanceOf(Array);
  });

  test("returns 404 for non-existent session", async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions/not-found", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.api_id).toBeDefined();
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toBe("Session not found");
  });
});
