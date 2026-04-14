import { describe, test, expect, mock, beforeEach } from "bun:test";
import * as jose from "jose";

// ── Mock side-effectful modules before importing the app ────────────────────

const mockInsertSession = mock(() => Promise.resolve());
const mockSql = mock((..._args: any[]) => Promise.resolve([]));

mock.module("../src/config.js", () => ({
  config: {
    PORT: 9090,
    LIVEKIT_API_KEY: "test-api-key",
    LIVEKIT_API_SECRET: "test-secret-that-is-long-enough",
    AUTO_MIGRATE: false,
    DATABASE_URL: "postgres://localhost:5432/test",
    S3_REGION: "us-east-1",
    S3_PREFIX: "recordings",
  },
  s3Enabled: false,
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

const API_KEY = "test-api-key";
const API_SECRET = "test-secret-that-is-long-enough";

async function signJwt(): Promise<string> {
  const secret = new TextEncoder().encode(API_SECRET);
  return new jose.SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(API_KEY)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(secret);
}

function makeRequest(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:9090${path}`, init);
}

// ── Health check ────────────────────────────────────────────────────────────

describe("GET /health", () => {
  test("returns status ok", async () => {
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
    const body = await res.json();
    expect(body.error).toContain("Missing or invalid Authorization header");
  });

  test("rejects request with invalid JWT", async () => {
    const form = new FormData();
    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: "Bearer invalid-token" },
        body: form,
      })
    );
    expect(res.status).toBe(401);
  });

  test("accepts valid request and calls insertSession", async () => {
    const token = await signJwt();
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
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");

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

  test("handles request with no chat history", async () => {
    const token = await signJwt();
    const form = new FormData();

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
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

    const token = await signJwt();
    const form = new FormData();

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
    );

    expect(res.status).toBe(200);
    expect(mockInsertSession).toHaveBeenCalledTimes(1);
  });

  test("handles malformed chat history JSON gracefully", async () => {
    const token = await signJwt();
    const form = new FormData();
    form.append("chat_history", new Blob(["not valid json"], { type: "application/json" }));

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
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

  test("returns paginated sessions list", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 2 }])
      .mockResolvedValueOnce([
        { id: 1, session_id: "sess-1", turn_count: 3, created_at: "2025-01-01" },
        { id: 2, session_id: "sess-2", turn_count: 5, created_at: "2025-01-02" },
      ]);

    const res = await server.fetch(makeRequest("/api/sessions?page=1&limit=10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.data).toHaveLength(2);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(10);
  });

  test("applies default pagination", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(makeRequest("/api/sessions"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page).toBe(1);
    expect(body.limit).toBe(50);
  });

  test("clamps limit to 100", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(makeRequest("/api/sessions?limit=999"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(100);
  });

  test("clamps page minimum to 1", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(makeRequest("/api/sessions?page=-5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page).toBe(1);
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

    const res = await server.fetch(makeRequest("/api/sessions/sess-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session_id).toBe("sess-1");
    expect(body.chat_history).toBeInstanceOf(Array);
    // session_metrics is now computed inline
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

    const res = await server.fetch(makeRequest("/api/sessions/sess-2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chat_history).toBeInstanceOf(Array);
  });

  test("returns 404 for non-existent session", async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = await server.fetch(makeRequest("/api/sessions/not-found"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });
});

// Note: GET /api/sessions/:id/metrics endpoint was merged into GET /api/sessions/:id
