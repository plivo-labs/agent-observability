import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";

// ── Mock side-effectful modules before importing the app ────────────────────

const mockInsertSession = mock(() => Promise.resolve());
const mockApplyStoredSessionTags = mock(() => Promise.resolve());
const mockUpsertSessionTag = mock(() => Promise.resolve());
const mockInsertLiveKitEvaluation = mock(() => Promise.resolve());
const mockUpsertSessionOutcome = mock(() => Promise.resolve());
const mockApplySessionTagMetadata = mock(() => Promise.resolve());
const mockMergeSessionRawReport = mock(() => Promise.resolve());
const mockSql: any = mock((..._args: any[]) => Promise.resolve([]));
// Route `sql.unsafe(...)` through the same queue as `sql\`...\`` so the
// existing `.mockResolvedValueOnce(...)` pattern works for both call styles.
mockSql.unsafe = mockSql;
// `sql.begin(fn)` is used by the recordings handler so the agent upsert
// and session insert share one transaction. The mock just invokes the
// callback with the same handle — no real isolation, but the test
// surface only cares that the inner calls happen.
mockSql.begin = (fn: (tx: any) => Promise<unknown>) => fn(mockSql);

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";
const LIVEKIT_API_KEY = "plivo-labs-livekit-api-key";
const LIVEKIT_API_SECRET = "plivo-labs-livekit-api-secret";

mock.module("../src/config.js", () => ({
  config: {
    PORT: 9090,
    AGENT_OBSERVABILITY_USER: TEST_USER,
    AGENT_OBSERVABILITY_PASS: TEST_PASS,
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET,
    AUTO_MIGRATE: false,
    DATABASE_URL: "postgres://localhost:5432/test",
    S3_REGION: "us-east-1",
    S3_PREFIX: "recordings",
  },
  s3Enabled: false,
  basicAuthEnabled: true,
  liveKitAuthEnabled: true,
}));

mock.module("../src/db.js", () => ({
  sql: mockSql,
  insertSession: mockInsertSession,
  applyStoredSessionTags: mockApplyStoredSessionTags,
  upsertSessionTag: mockUpsertSessionTag,
  insertLiveKitEvaluation: mockInsertLiveKitEvaluation,
  upsertSessionOutcome: mockUpsertSessionOutcome,
  applySessionTagMetadata: mockApplySessionTagMetadata,
  mergeSessionRawReport: mockMergeSessionRawReport,
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

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function liveKitBearerHeader(overrides?: Record<string, unknown>, secret = LIVEKIT_API_SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    observability: { write: true },
    sub: "",
    iss: LIVEKIT_API_KEY,
    nbf: now - 1,
    exp: now + 3600,
    ...(overrides ?? {}),
  }));
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest();
  return `Bearer ${signingInput}.${base64Url(signature)}`;
}

function makeRequest(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:9090${path}`, init);
}

function blobPart(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function varint(value: number | bigint): Buffer {
  let n = BigInt(value);
  const bytes: number[] = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0n);
  return Buffer.from(bytes);
}

function fieldTag(field: number, wire: number): Buffer {
  return varint((field << 3) | wire);
}

function lengthDelimited(field: number, body: Buffer): Buffer {
  return Buffer.concat([fieldTag(field, 2), varint(body.length), body]);
}

function stringField(field: number, value: string): Buffer {
  return lengthDelimited(field, Buffer.from(value, "utf8"));
}

function varintField(field: number, value: number | bigint): Buffer {
  return Buffer.concat([fieldTag(field, 0), varint(value)]);
}

function fixed64Field(field: number, value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return Buffer.concat([fieldTag(field, 1), out]);
}

function timestamp(seconds: number): Buffer {
  return Buffer.concat([varintField(1, seconds)]);
}

function buildRecordingHeader(roomId: string, startSeconds: number): Buffer {
  return Buffer.concat([
    stringField(1, roomId),
    lengthDelimited(4, timestamp(startSeconds)),
  ]);
}

function anyValue(value: unknown): Buffer {
  if (typeof value === "string") {
    return stringField(1, value);
  }
  if (typeof value === "boolean") {
    return varintField(2, value ? 1 : 0);
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return varintField(3, value);
  }
  if (Array.isArray(value)) {
    const body = Buffer.concat(value.map((item) => lengthDelimited(1, anyValue(item))));
    return lengthDelimited(5, body);
  }
  if (value && typeof value === "object") {
    const body = Buffer.concat(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => lengthDelimited(1, keyValue(key, item))),
    );
    return lengthDelimited(6, body);
  }
  return stringField(1, "");
}

function keyValue(key: string, value: unknown): Buffer {
  return Buffer.concat([
    stringField(1, key),
    lengthDelimited(2, anyValue(value)),
  ]);
}

function logRecord(body: string, attrs: Record<string, unknown>): Buffer {
  const attrBytes = Object.entries(attrs).map(([key, value]) => lengthDelimited(6, keyValue(key, value)));
  return Buffer.concat([
    fixed64Field(1, BigInt(Date.now()) * 1_000_000n),
    lengthDelimited(5, anyValue(body)),
    ...attrBytes,
  ]);
}

function buildLogsRequest(records: Array<{ body: string; attrs: Record<string, unknown> }>): Buffer {
  const scopeLogs = Buffer.concat(records.map((record) => lengthDelimited(2, logRecord(record.body, record.attrs))));
  const resourceLogs = lengthDelimited(2, scopeLogs);
  return lengthDelimited(1, resourceLogs);
}

function jsonAnyValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { stringValue: "" };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(jsonAnyValue) } };
  }
  if (typeof value === "object") {
    return {
      kvlistValue: {
        values: Object.entries(value as Record<string, unknown>).map(([key, item]) => ({
          key,
          value: jsonAnyValue(item),
        })),
      },
    };
  }
  return { stringValue: String(value) };
}

function jsonAttributes(attrs: Record<string, unknown>): Array<{ key: string; value: Record<string, unknown> }> {
  return Object.entries(attrs).map(([key, value]) => ({ key, value: jsonAnyValue(value) }));
}

function buildJsonLogsRequest(records: Array<{ body: string; attrs: Record<string, unknown> }>): Record<string, unknown> {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: jsonAttributes({ "service.name": "livekit-agents", room_id: "room-json-otlp" }),
        },
        scopeLogs: [
          {
            scope: { name: "chat_history", attributes: jsonAttributes({ room_id: "room-json-otlp" }) },
            logRecords: records.map((record, index) => ({
              timeUnixNano: String((BigInt(Date.now()) + BigInt(index)) * 1_000_000n),
              body: jsonAnyValue(record.body),
              attributes: jsonAttributes(record.attrs),
            })),
          },
        ],
      },
    ],
  };
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
    mockApplyStoredSessionTags.mockClear();
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

  test("rejects an oversized body with 413 before reading it", async () => {
    // 17 MiB exceeds the 16 MiB OTLP cap. bodyLimit is mounted ahead of
    // auth, so the request is refused with no credentials and the body is
    // never buffered whole into memory.
    const oversized = Buffer.alloc(17 * 1024 * 1024, 0x41);
    const res = await server.fetch(
      makeRequest("/observability/logs/otlp/v0", {
        method: "POST",
        body: oversized,
      })
    );
    expect(res.status).toBe(413);
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

  test("accepts valid LiveKit Bearer auth", async () => {
    const form = new FormData();
    form.append("header", new Blob([blobPart(buildRecordingHeader("room-jwt", 1700000000))], { type: "application/protobuf" }));

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: liveKitBearerHeader() },
        body: form,
      }),
    );

    expect(res.status).toBe(200);
    expect(mockInsertSession).toHaveBeenCalledTimes(1);
    const call = (mockInsertSession.mock.calls as any[])[0][0] as any;
    expect(call.sessionId).toBe("room-jwt");
  });

  test("rejects LiveKit Bearer auth with an invalid signature", async () => {
    const form = new FormData();

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: liveKitBearerHeader({}, "wrong-secret") },
        body: form,
      }),
    );

    expect(res.status).toBe(401);
  });

  test("rejects LiveKit Bearer auth without observability.write grant", async () => {
    // Token is valid (correct signature, issuer, exp) but the grant body
    // says read-only. The middleware must reject — we don't want a token
    // that can read other resources to also be able to write sessions.
    const form = new FormData();

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: liveKitBearerHeader({ observability: { read: true } }) },
        body: form,
      }),
    );

    expect(res.status).toBe(401);
  });

  test("rejects LiveKit Bearer auth when observability claim is missing entirely", async () => {
    // `observability: undefined` causes JSON.stringify to drop the field,
    // so the JWT carries no observability claim at all. Defence-in-depth
    // for tokens minted for other LiveKit features but somehow shipped
    // without the observability scope.
    const form = new FormData();

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: liveKitBearerHeader({ observability: undefined }) },
        body: form,
      }),
    );

    expect(res.status).toBe(401);
  });

  // ── agent_id ingest extraction ─────────────────────────────────────────
  //
  // Three extraction paths from rawReport (in order of precedence):
  //   1. rawReport.agent_id (top-level field)
  //   2. rawReport.tags[] entry matching /^agent_id:.+/
  // When neither is present the route still accepts the upload with
  // agentId=null — agent_transport_sessions.agent_id is nullable (mig
  // 014), and the OTLP "tag" body that arrives ~1s later carries
  // `agent_id:<uuid>` which `applySessionTagMetadata` backfills via
  // an UPDATE keyed on session_id. Same shape `account_id` follows.
  // Header-only POSTs (no chat_history blob) also accept with null.

  test("accepts with agent_id=null when rawReport carries no agent identifier", async () => {
    const chatHistory = JSON.stringify({
      // No agent_id, no tags carrying it. The route used to 400 here;
      // we now accept and rely on the OTLP backfill path.
      items: [
        { id: "m1", type: "message", role: "user" },
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
    expect(mockInsertSession).toHaveBeenCalledTimes(1);
    const call = (mockInsertSession.mock.calls as any[])[0][0] as any;
    expect(call.agentId).toBeNull();
  });

  test("extracts agent_id from rawReport.tags[] when no top-level field", async () => {
    const chatHistory = JSON.stringify({
      // No top-level agent_id — the SDK's `_ensure_transport_tags`
      // path puts the id in the tags array via "agent_id:<uuid>".
      tags: [
        "account_id:acct-123",
        "agent_id:99999999-aaaa-bbbb-cccc-dddddddddddd",
        "transport:audio_stream",
      ],
      items: [],
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
    expect(mockInsertSession).toHaveBeenCalledTimes(1);
    const call = (mockInsertSession.mock.calls as any[])[0][0] as any;
    expect(call.agentId).toBe("99999999-aaaa-bbbb-cccc-dddddddddddd");
  });

  test("top-level rawReport.agent_id beats the tags[] fallback", async () => {
    // Both paths populated — the explicit field wins. Pinning this so a
    // future refactor doesn't silently flip the precedence.
    const chatHistory = JSON.stringify({
      agent_id: "top-level-wins-uuid",
      tags: ["agent_id:tags-fallback-uuid"],
      items: [],
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
    const call = (mockInsertSession.mock.calls as any[])[0][0] as any;
    expect(call.agentId).toBe("top-level-wins-uuid");
  });

  test("accepts with agent_id=null when rawReport is absent (header-only POST)", async () => {
    // No chat_history blob → rawReport stays null → no extractor source.
    // insertSession runs with agentId=null; OTLP tag arriving later
    // backfills the column via applySessionTagMetadata.
    const form = new FormData();
    form.append("header", new Blob([JSON.stringify({ session_id: "no-history" })], { type: "application/json" }));

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: basicAuthHeader() },
        body: form,
      })
    );

    expect(res.status).toBe(200);
    expect(mockInsertSession).toHaveBeenCalledTimes(1);
    const call = (mockInsertSession.mock.calls as any[])[0][0] as any;
    expect(call.agentId).toBeNull();
  });

  test("accepts valid request and calls insertSession", async () => {
    const chatHistory = JSON.stringify({
      // Happy path: top-level agent_id ships in chat_history and is
      // extracted here at multipart time. The SDK also puts it on the
      // OTLP session-report log's attributes for the backfill channel,
      // but when this field is populated up front the UPDATE is a no-op.
      agent_id: "11111111-2222-3333-4444-555555555555",
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
    const call = (mockInsertSession.mock.calls as any[])[0][0] as any;
    // 1 assistant message → 1 turn (logical user→assistant pair).
    // parse.ts counts only assistant items so this column agrees with
    // metrics.ts:summary.total_turns on the same dialog.
    expect(call.turnCount).toBe(1);
    expect(call.hasStt).toBe(true);
    expect(call.hasLlm).toBe(true);
    expect(call.hasTts).toBe(true);
    expect(call.chatHistory).toHaveLength(2);
    expect(call.sessionMetrics.per_turn).toHaveLength(2);
    expect(call.sessionMetrics.usage).toBeNull();
  });

  test("parses native LiveKit protobuf header", async () => {
    const form = new FormData();
    form.append("header", new Blob([blobPart(buildRecordingHeader("room-native", 1700000000))], { type: "application/protobuf" }));

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: basicAuthHeader() },
        body: form,
      })
    );

    expect(res.status).toBe(200);
    expect(mockInsertSession).toHaveBeenCalledTimes(1);
    const call = (mockInsertSession.mock.calls as any[])[0][0] as any;
    expect(call.sessionId).toBe("room-native");
    expect(call.startedAt).toBeInstanceOf(Date);
    expect(mockApplyStoredSessionTags).toHaveBeenCalledWith("room-native");
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
    const call = (mockInsertSession.mock.calls as any[])[0][0] as any;
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
    const call = (mockInsertSession.mock.calls as any[])[0][0] as any;
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
    const call = (mockInsertSession.mock.calls as any[])[0][0] as any;
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
    const call = (mockInsertSession.mock.calls as any[])[0][0] as any;
    expect(call.turnCount).toBe(0);
    expect(call.hasStt).toBe(false);
    expect(call.hasLlm).toBe(false);
    expect(call.hasTts).toBe(false);
    expect(call.chatHistory).toEqual([]);
  });

  test("returns 503 when insertSession fails so the SDK retries", async () => {
    mockInsertSession.mockImplementationOnce(() => Promise.reject(new Error("db down")));

    const form = new FormData();

    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: basicAuthHeader() },
        body: form,
      })
    );

    // A 200 here would make the SDK drop the report (permanent data loss);
    // a 5xx triggers its at-least-once retry instead.
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error?.code ?? body.code).toBe("session_save_failed");
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
    const call = (mockInsertSession.mock.calls as any[])[0][0] as any;
    expect(call.turnCount).toBe(0);
    expect(call.chatHistory).toEqual([]);
  });
});

// ── Native LiveKit OTLP logs ────────────────────────────────────────────────

describe("POST /observability/logs/otlp/v0", () => {
  beforeEach(() => {
    mockUpsertSessionTag.mockClear();
    mockInsertLiveKitEvaluation.mockClear();
    mockUpsertSessionOutcome.mockClear();
    mockApplySessionTagMetadata.mockClear();
    mockMergeSessionRawReport.mockClear();
  });

  test("accepts OTLP tag, session report, chat item, and evaluation records", async () => {
    const body = buildLogsRequest([
      {
        body: "session report",
        attrs: {
          room_id: "room-otlp",
          "session.options": { max_tool_steps: 3, preemptive_generation: true },
          "session.tags": ["lk.success"],
          agent_name: "support-agent",
          sdk_version: "1.5.2",
        },
      },
      {
        body: "chat item",
        attrs: {
          room_id: "room-otlp",
          "chat.item": {
            message: {
              id: "item-1",
              role: "ASSISTANT",
              content: [{ text: "Hello" }],
              created_at: "2026-04-29T10:15:27.829Z",
            },
          },
        },
      },
      {
        body: "tag",
        attrs: {
          room_id: "room-otlp",
          tag: { name: "account_id:acct-1", metadata: { account_id: "acct-1" } },
        },
      },
      {
        body: "evaluation",
        attrs: {
          room_id: "room-otlp",
          evaluation: {
            name: "task_completion",
            tag: "lk.judge.task_completion:pass",
            verdict: "pass",
            reasoning: "completed",
            instructions: "Check whether the task was completed",
          },
        },
      },
    ]);

    const res = await server.fetch(
      makeRequest("/observability/logs/otlp/v0", {
        method: "POST",
        headers: { Authorization: basicAuthHeader(), "Content-Type": "application/x-protobuf" },
        body: blobPart(body),
      }),
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.accepted).toBe(4);
    expect(payload.tags).toBe(2);
    expect(payload.evaluations).toBe(1);
    expect(mockUpsertSessionTag).toHaveBeenCalledTimes(2);
    expect(mockApplySessionTagMetadata).toHaveBeenCalledWith("room-otlp", [
      { name: "account_id:acct-1", metadata: { account_id: "acct-1" } },
    ]);
    expect(mockInsertLiveKitEvaluation).toHaveBeenCalledTimes(1);
    expect(mockMergeSessionRawReport).toHaveBeenCalledWith({
      sessionId: "room-otlp",
      patch: {
        options: { max_tool_steps: 3, preemptive_generation: true },
        tags: ["lk.success"],
        agent_name: "support-agent",
        sdk_version: "1.5.2",
        events: [
          {
            type: "conversation_item_added",
            created_at: Date.parse("2026-04-29T10:15:27.829Z") / 1000,
            item: {
              id: "item-1",
              role: "assistant",
              content: ["Hello"],
              created_at: "2026-04-29T10:15:27.829Z",
              type: "message",
            },
          },
        ],
      },
    });
  });

  test("accepts OTLP JSON logs from Node SDK-style exporters", async () => {
    const body = buildJsonLogsRequest([
      {
        body: "session report",
        attrs: {
          room_id: "room-json-otlp",
          "session.options": { max_tool_steps: 2 },
          agent_name: "node-support-agent",
        },
      },
      {
        body: "chat item",
        attrs: {
          room_id: "room-json-otlp",
          "chat.item": {
            function_call: {
              id: "item-tool",
              name: "lookup_order",
              call_id: "call-tool",
              arguments: { order_id: "1003" },
              created_at: "2026-04-29T10:15:28.829Z",
            },
          },
        },
      },
    ]);

    const res = await server.fetch(
      makeRequest("/observability/logs/otlp/v0", {
        method: "POST",
        headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.accepted).toBe(2);
    expect(payload.tags).toBe(0);
    expect(payload.evaluations).toBe(0);
    expect(mockMergeSessionRawReport).toHaveBeenCalledWith({
      sessionId: "room-json-otlp",
      patch: {
        options: { max_tool_steps: 2 },
        agent_name: "node-support-agent",
        events: [
          {
            type: "conversation_item_added",
            created_at: Date.parse("2026-04-29T10:15:28.829Z") / 1000,
            item: {
              id: "item-tool",
              name: "lookup_order",
              call_id: "call-tool",
              arguments: { order_id: "1003" },
              created_at: "2026-04-29T10:15:28.829Z",
              type: "function_call",
            },
          },
        ],
      },
    });
    expect(mockApplySessionTagMetadata).not.toHaveBeenCalled();
    expect(mockInsertLiveKitEvaluation).not.toHaveBeenCalled();
  });

  test("accepts raw session.report logs from Agent Transport Node", async () => {
    const body = buildJsonLogsRequest([
      {
        body: "session report",
        attrs: {
          room_id: "room-node-raw-report",
          agent_name: "node-support-agent",
          sdk_version: "1.2.3",
          room_tags: { account_id: "acct-node", transport: "audio_stream" },
          "session.report": {
            job_id: "job-room-node-raw-report",
            room_id: "room-node-raw-report",
            room: "room-node-raw-report",
            options: { max_tool_steps: 2 },
            events: [
              {
                type: "conversation_item_added",
                created_at: Date.parse("2026-04-29T10:15:28.829Z") / 1000,
                item: {
                  function_call: {
                    id: "item-tool",
                    name: "lookup_order",
                    call_id: "call-tool",
                    arguments: { order_id: "1003" },
                    created_at: "2026-04-29T10:15:28.829Z",
                  },
                },
              },
            ],
            usage: [{ type: "llm_usage", input_tokens: 10, output_tokens: 5 }],
          },
        },
      },
    ]);

    const res = await server.fetch(
      makeRequest("/observability/logs/otlp/v0", {
        method: "POST",
        headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.accepted).toBe(1);
    expect(payload.tags).toBe(0);
    expect(payload.evaluations).toBe(0);
    expect(mockMergeSessionRawReport).toHaveBeenCalledWith({
      sessionId: "room-node-raw-report",
      patch: {
        job_id: "job-room-node-raw-report",
        room_id: "room-node-raw-report",
        room: "room-node-raw-report",
        options: { max_tool_steps: 2 },
        events: [
          {
            type: "conversation_item_added",
            created_at: Date.parse("2026-04-29T10:15:28.829Z") / 1000,
            item: {
              function_call: {
                id: "item-tool",
                name: "lookup_order",
                call_id: "call-tool",
                arguments: { order_id: "1003" },
                created_at: "2026-04-29T10:15:28.829Z",
              },
            },
          },
        ],
        usage: [{ type: "llm_usage", input_tokens: 10, output_tokens: 5 }],
        agent_name: "node-support-agent",
        sdk_version: "1.2.3",
      },
    });
  });

  test("normalizes OTLP JSON-string attributes before persisting", async () => {
    const body = buildLogsRequest([
      {
        body: "session report",
        attrs: {
          room_id: "room-string-otlp",
          "session.options": JSON.stringify({ max_tool_steps: 4 }),
          "session.tags": JSON.stringify(["account_id:acct-json", "lk.success"]),
          usage: JSON.stringify([{ type: "llm_usage", input_tokens: 12, output_tokens: 3 }]),
        },
      },
      {
        body: "chat item",
        attrs: {
          room_id: "room-string-otlp",
          "chat.item": JSON.stringify({
            message: {
              id: "item-json",
              role: "USER",
              content: [{ text: "hello" }],
              created_at: "2026-04-29T10:15:27.829Z",
            },
          }),
        },
      },
      {
        body: "chat item",
        attrs: {
          room_id: "room-string-otlp",
          "chat.item": JSON.stringify({
            function_call: {
              id: "item-tool",
              name: "lookup_order",
              call_id: "call-tool",
              arguments: "{\"order_id\":\"1003\"}",
              created_at: "2026-04-29T10:15:28.829Z",
            },
          }),
        },
      },
      {
        body: "tag",
        attrs: {
          room_id: "room-string-otlp",
          tag: JSON.stringify({ name: "transport:audio_stream", metadata: { transport: "audio_stream" } }),
        },
      },
      {
        body: "evaluation",
        attrs: {
          room_id: "room-string-otlp",
          evaluation: JSON.stringify({
            name: "accuracy",
            verdict: "pass",
            reasoning: "grounded",
          }),
        },
      },
    ]);

    const res = await server.fetch(
      makeRequest("/observability/logs/otlp/v0", {
        method: "POST",
        headers: { Authorization: basicAuthHeader(), "Content-Type": "application/x-protobuf" },
        body: blobPart(body),
      }),
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.accepted).toBe(5);
    expect(payload.tags).toBe(3);
    expect(payload.evaluations).toBe(1);
    expect(mockMergeSessionRawReport).toHaveBeenCalledWith({
      sessionId: "room-string-otlp",
      patch: {
        options: { max_tool_steps: 4 },
        tags: ["account_id:acct-json", "lk.success"],
        usage: [{ type: "llm_usage", input_tokens: 12, output_tokens: 3 }],
        events: [
          {
            type: "conversation_item_added",
            created_at: Date.parse("2026-04-29T10:15:27.829Z") / 1000,
            item: {
              id: "item-json",
              role: "user",
              content: ["hello"],
              created_at: "2026-04-29T10:15:27.829Z",
              type: "message",
            },
          },
          {
            type: "conversation_item_added",
            created_at: Date.parse("2026-04-29T10:15:28.829Z") / 1000,
            item: {
              id: "item-tool",
              name: "lookup_order",
              call_id: "call-tool",
              arguments: "{\"order_id\":\"1003\"}",
              created_at: "2026-04-29T10:15:28.829Z",
              type: "function_call",
            },
          },
        ],
      },
    });
    expect(mockApplySessionTagMetadata).toHaveBeenCalledWith("room-string-otlp", [
      { name: "transport:audio_stream", metadata: { transport: "audio_stream" } },
    ]);
    expect(mockInsertLiveKitEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "room-string-otlp",
      judgeName: "accuracy",
      verdict: "pass",
    }));
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

  test("clamps limit to 50", async () => {
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
    expect(body.meta.limit).toBe(50);
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

  test("passes account_id filter as a case-insensitive LIKE predicate", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?account_id=Acct-XYZ", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    // Count + rows = 2 SQL calls; both must include the WHERE clause and the param.
    expect(mockSql).toHaveBeenCalledTimes(2);
    const [countQuery, countParams] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(countQuery).toContain("WHERE LOWER(account_id) LIKE");
    expect(countParams).toEqual(["%acct-xyz%"]);
    const [rowsQuery, rowsParams] = mockSql.mock.calls[1] as [string, unknown[]];
    expect(rowsQuery).toContain("WHERE LOWER(account_id) LIKE");
    expect(rowsParams).toEqual(["%acct-xyz%", 20, 0]);
  });

  test("escapes LIKE metacharacters in account_id input", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?account_id=" + encodeURIComponent("50% off_lab"), {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    const [, countParams] = mockSql.mock.calls[0] as [string, unknown[]];
    // `%` and `_` are escaped, lower-cased, then wrapped in `%...%`.
    expect(countParams).toEqual(["%50\\% off\\_lab%"]);
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
    expect(countQuery).toMatch(/LOWER\(account_id\) LIKE \$1.*AND.*started_at >= \$2.*AND.*started_at <= \$3/s);
    expect(countParams).toEqual(["%acct-1%", from, to]);
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

  test("returns native session evaluation data", async () => {
    mockSql
      .mockResolvedValueOnce([
        {
          id: 1,
          session_id: "sess-eval",
          turn_count: 0,
          chat_history: [],
          session_metrics: { per_turn: [], usage: null },
        },
      ])
      .mockResolvedValueOnce([
        {
          name: "agent.session",
          metadata: JSON.stringify({ account_id: "acct-1", transport: "sip" }),
          source: "livekit_otlp",
          observed_at: "2026-04-14T10:03:47Z",
          created_at: "2026-04-14T10:03:47Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          source: "livekit_otlp",
          judge_name: "resolution_quality",
          tag: "agent.session",
          verdict: "pass",
          reasoning: "Resolved",
          instructions: "Resolve the user request",
          observed_at: "2026-04-14T10:03:48Z",
          raw: JSON.stringify({ score: 0.92 }),
          created_at: "2026-04-14T10:03:48Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          source: "livekit_otlp",
          outcome: "success",
          reason: "All judges passed",
          observed_at: "2026-04-14T10:03:49Z",
          raw: JSON.stringify({ outcome: "success" }),
          created_at: "2026-04-14T10:03:49Z",
        },
      ]);

    const res = await server.fetch(
      makeRequest("/api/sessions/sess-eval", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tags).toHaveLength(1);
    expect(body.tags[0].metadata.account_id).toBe("acct-1");
    expect(body.evaluations).toHaveLength(1);
    expect(body.evaluations[0].judge_name).toBe("resolution_quality");
    expect(body.evaluations[0].raw.score).toBe(0.92);
    expect(body.outcome.outcome).toBe("success");
    expect(body.outcome.raw.outcome).toBe("success");
  });

  test("sorts session events by created_at", async () => {
    const chatHistory = [
      { id: "u1", type: "message", role: "user", content: "hi", metrics: {} },
    ];
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        session_id: "sess-events",
        turn_count: 1,
        chat_history: JSON.stringify(chatHistory),
        session_metrics: JSON.stringify({ per_turn: [], usage: null }),
        raw_report: JSON.stringify({
          events: [
            { type: "late", created_at: 3 },
            { type: "untimed" },
            { type: "early", created_at: 1 },
            { type: "middle", created_at: "1970-01-01T00:00:02Z" },
          ],
          options: {},
        }),
      },
    ]);

    const res = await server.fetch(
      makeRequest("/api/sessions/sess-events", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.map((event: any) => event.type)).toEqual([
      "early",
      "middle",
      "late",
      "untimed",
    ]);
  });

  test("normalizes legacy stringified raw_report arrays for events and options", async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        session_id: "sess-legacy-raw",
        turn_count: 0,
        chat_history: [],
        session_metrics: JSON.stringify({ per_turn: [], usage: null }),
        raw_report: [
          {},
          JSON.stringify({
            options: { max_tool_steps: 3 },
            tags: ["account_id:acct-raw"],
          }),
          {
            events: [
              JSON.stringify([
                { type: "late", created_at: 3 },
                { type: "early", created_at: 1 },
                {
                  type: "conversation_item_added",
                  created_at: 2,
                  item: {
                    function_call: {
                      name: "lookup_order",
                      arguments: "{\"order_id\":\"1003\"}",
                    },
                  },
                },
              ]),
            ],
          },
        ],
      },
    ]);

    const res = await server.fetch(
      makeRequest("/api/sessions/sess-legacy-raw", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.options).toEqual({ max_tool_steps: 3 });
    expect(body.events.map((event: any) => event.type)).toEqual([
      "early",
      "conversation_item_added",
      "late",
    ]);
    expect(body.events[1].item).toEqual({
      name: "lookup_order",
      arguments: "{\"order_id\":\"1003\"}",
      type: "function_call",
    });
    expect(body.raw_report.tags).toEqual(["account_id:acct-raw"]);
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

// ── Dashboard API: DELETE /api/sessions ─────────────────────────────────────

describe("DELETE /api/sessions", () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  test("rejects without auth", async () => {
    const res = await server.fetch(
      makeRequest("/api/sessions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ["a"] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("400 when body is not JSON", async () => {
    const res = await server.fetch(
      makeRequest("/api/sessions", {
        method: "DELETE",
        headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
        body: "not-json",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
  });

  test("400 when session_ids is missing or empty", async () => {
    const cases: Array<unknown> = [
      undefined,
      [],
      ["", "valid"],
      [123],
    ];
    for (const ids of cases) {
      const res = await server.fetch(
        makeRequest("/api/sessions", {
          method: "DELETE",
          headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
          body: JSON.stringify({ session_ids: ids }),
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_payload");
    }
  });

  test("400 when more than 200 ids", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `s-${i}`);
    const res = await server.fetch(
      makeRequest("/api/sessions", {
        method: "DELETE",
        headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ids }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("too_many");
  });

  test("returns deleted count from RETURNING rows", async () => {
    mockSql.mockResolvedValueOnce([
      { session_id: "sess-1" },
      { session_id: "sess-2" },
    ]);

    const res = await server.fetch(
      makeRequest("/api/sessions", {
        method: "DELETE",
        headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ["sess-1", "sess-2", "sess-missing"] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(2);
    expect(body.api_id).toBeDefined();
  });
});

// ── Fleet analytics stats ────────────────────────────────────────────────────

describe("GET /api/analytics/stats", () => {
  beforeEach(() => {
    mockSql.mockClear();
    // mockResolvedValueOnce drops the base implementation once its queue
    // drains — restore the resolve-empty default for unqueued queries.
    mockSql.mockImplementation((..._args: any[]) => Promise.resolve([]));
  });

  test("requires auth", async () => {
    const res = await server.fetch(makeRequest("/api/analytics/stats"));
    expect(res.status).toBe(401);
  });

  test("returns fleet stats with computed rates", async () => {
    // Queries start in call order: stats-core buckets, stats-core totals,
    // fleet extras, interruption buckets, agent breakdown, account breakdown.
    mockSql.mockResolvedValueOnce([
      {
        bucket_start: "2026-06-10T00:00:00Z",
        session_count: 4,
        avg_duration_ms: 30000,
        estimated_cost_usd: "0.5",
        p95_user_perceived_ms: 1200,
      },
    ]);
    mockSql.mockResolvedValueOnce([
      {
        total_sessions: 4,
        total_estimated_cost_usd: "0.5",
        avg_duration_ms: 30000,
        avg_turn_count: "3.5",
        p50_user_perceived_ms: 800,
        p95_user_perceived_ms: 1200,
        p99_user_perceived_ms: 1500,
        llm_pass_rate: "0.75",
        ci_pass_rate: null,
      },
    ]);
    mockSql.mockResolvedValueOnce([
      {
        active_agents: 2,
        assistant_turns: 10,
        interrupted_turns: 2,
        outcome_success_rate: "0.5",
      },
    ]);
    mockSql.mockResolvedValueOnce([
      { bucket_start: "2026-06-10T00:00:00Z", assistant_turns: 10, interrupted_turns: 2 },
    ]);
    mockSql.mockResolvedValueOnce([
      {
        agent_id: "agent-a",
        agent_name: "Support Bot",
        session_count: 3,
        avg_duration_ms: 20000,
        estimated_cost_usd: "0.3",
        p95_user_perceived_ms: 1000,
        assistant_turns: 8,
        interrupted_turns: 2,
        outcome_total: 2,
        outcome_success: 1,
      },
    ]);
    mockSql.mockResolvedValueOnce([
      { account_id: "acct-1", session_count: 4, estimated_cost_usd: "0.5" },
    ]);

    const res = await server.fetch(
      makeRequest("/api/analytics/stats?range=7d", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.api_id).toBeDefined();
    expect(body.range).toBe("7d");
    expect(body.total_sessions).toBe(4);
    expect(body.active_agents).toBe(2);
    expect(body.interruption_rate).toBeCloseTo(0.2);
    expect(body.llm_pass_rate).toBeCloseTo(0.75);
    expect(body.outcome_success_rate).toBeCloseTo(0.5);
    expect(body.ci_pass_rate).toBeNull();
    expect(body.buckets).toHaveLength(1);
    expect(body.buckets[0].interruption_rate).toBeCloseTo(0.2);
    expect(body.buckets[0].estimated_cost_usd).toBeCloseTo(0.5);
    expect(body.agent_breakdown).toHaveLength(1);
    expect(body.agent_breakdown[0].interruption_rate).toBeCloseTo(0.25);
    expect(body.agent_breakdown[0].outcome_success_rate).toBeCloseTo(0.5);
    expect(body.account_breakdown[0].account_id).toBe("acct-1");
  });

  test("clamps unknown range to the default", async () => {
    const res = await server.fetch(
      makeRequest("/api/analytics/stats?range=bogus", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.range).toBe("7d");
    // Stats-core bucket query params: [agentId, interval, bucket, accountId].
    const firstCallParams = mockSql.mock.calls[0][1];
    expect(firstCallParams[0]).toBeNull(); // fleet-wide: no agent filter
    expect(firstCallParams[1]).toBe("7 days");
  });

  test("passes account_id through to every query", async () => {
    const res = await server.fetch(
      makeRequest("/api/analytics/stats?range=24h&account_id=acct-9", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.account_id).toBe("acct-9");
    for (const call of mockSql.mock.calls) {
      expect(call[1]).toContain("acct-9");
    }
  });

  test("returns structured 500 when a query fails", async () => {
    mockSql.mockRejectedValueOnce(new Error("boom"));
    const res = await server.fetch(
      makeRequest("/api/analytics/stats", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("stats_failed");
  });
});
