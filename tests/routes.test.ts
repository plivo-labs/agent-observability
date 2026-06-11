/**
 * Endpoint tests for the ingest surface: health check, the multipart
 * session-report recording endpoint, and OTLP log ingest (JSON, protobuf,
 * gzip; Basic and LiveKit Bearer auth). Dashboard API tests live in
 * dashboard-api.test.ts; the shared mock preamble lives in test-app.ts.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  registerAppMocks,
  server,
  mockSql,
  mockInsertSession,
  mockApplyStoredSessionTags,
  mockUpsertSessionTag,
  mockInsertLiveKitEvaluation,
  mockUpsertSessionOutcome,
  mockApplySessionTagMetadata,
  mockMergeSessionRawReport,
  basicAuthHeader,
  liveKitBearerHeader,
  makeRequest,
} from "./test-app.js";

registerAppMocks();

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
    // basic + LiveKit auth are both enabled in the test config mock.
    expect(body.authEnabled).toBe(true);
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

  test("rejects a LiveKit Bearer token that has no exp claim", async () => {
    // exp: undefined is dropped by JSON.stringify, so the token never
    // expires. requiredClaims must reject it even though signature, issuer
    // and the write grant are all valid.
    const form = new FormData();
    const res = await server.fetch(
      makeRequest("/observability/recordings/v0", {
        method: "POST",
        headers: { Authorization: liveKitBearerHeader({ exp: undefined }) },
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

