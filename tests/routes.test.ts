import { describe, test, expect, mock, beforeEach } from "bun:test";
import * as jose from "jose";

// ── Mock side-effectful modules before importing the app ────────────────────

const mockInsertSession = mock(() => Promise.resolve());

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
  sql: {},
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
    expect(call.sessionMetrics).toHaveLength(2);
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
