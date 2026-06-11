import { describe, test, expect } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  decodeMetricsRecordingHeader,
  decodeOtlpLogsRequest,
} from "../../src/livekit/protobuf.js";

// ─── Minimal protobuf-encoding helpers for fixture construction ─────────────
//
// Hand-rolled instead of importing `@livekit/protocol` so the obs server has
// no test-time dependency on the LiveKit SDK and stays a black-box test of
// the wire format. Mirrors the helpers in routes.test.ts.

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

function timestamp(seconds: number, nanos = 0): Buffer {
  const parts = [varintField(1, seconds)];
  if (nanos > 0) parts.push(varintField(2, nanos));
  return Buffer.concat(parts);
}

function stringMapEntry(key: string, value: string): Buffer {
  return Buffer.concat([stringField(1, key), stringField(2, value)]);
}

// ─── decodeMetricsRecordingHeader ───────────────────────────────────────────

describe("decodeMetricsRecordingHeader", () => {
  test("returns empty defaults for an empty buffer", () => {
    const result = decodeMetricsRecordingHeader(new Uint8Array(0));
    expect(result).toEqual({
      roomId: "",
      startedAt: null,
      roomTags: {},
      roomName: null,
      roomStartedAt: null,
    });
  });

  test("decodes a header with only a room id (other fields default)", () => {
    const bytes = stringField(1, "room-only");
    const result = decodeMetricsRecordingHeader(new Uint8Array(bytes));
    expect(result.roomId).toBe("room-only");
    expect(result.startedAt).toBeNull();
    expect(result.roomTags).toEqual({});
    expect(result.roomName).toBeNull();
    expect(result.roomStartedAt).toBeNull();
  });

  test("decodes a fully-populated header", () => {
    const bytes = Buffer.concat([
      stringField(1, "room-full"),
      lengthDelimited(4, timestamp(1700000000)),
      lengthDelimited(5, stringMapEntry("account_id", "acct-1")),
      lengthDelimited(5, stringMapEntry("transport", "audio_stream")),
      stringField(6, "Demo Room"),
      lengthDelimited(7, timestamp(1699999000)),
    ]);
    const result = decodeMetricsRecordingHeader(new Uint8Array(bytes));

    expect(result.roomId).toBe("room-full");
    expect(result.startedAt?.getTime()).toBe(1700000000 * 1000);
    expect(result.roomTags).toEqual({ account_id: "acct-1", transport: "audio_stream" });
    expect(result.roomName).toBe("Demo Room");
    expect(result.roomStartedAt?.getTime()).toBe(1699999000 * 1000);
  });

  test("merges multiple room_tag entries into a single map", () => {
    const bytes = Buffer.concat([
      stringField(1, "room-tags"),
      lengthDelimited(5, stringMapEntry("account_id", "acct-1")),
      lengthDelimited(5, stringMapEntry("transport", "sip")),
      lengthDelimited(5, stringMapEntry("direction", "inbound")),
    ]);
    const result = decodeMetricsRecordingHeader(new Uint8Array(bytes));
    expect(result.roomTags).toEqual({
      account_id: "acct-1",
      transport: "sip",
      direction: "inbound",
    });
  });

  test("skips unknown fields gracefully (forward compat)", () => {
    // Field 99 doesn't exist in the schema yet — the decoder must skip it
    // without throwing so older servers can still parse newer headers.
    const bytes = Buffer.concat([
      stringField(1, "room-unknown"),
      stringField(99, "future-field"),
      lengthDelimited(4, timestamp(1700000001)),
    ]);
    const result = decodeMetricsRecordingHeader(new Uint8Array(bytes));
    expect(result.roomId).toBe("room-unknown");
    expect(result.startedAt?.getTime()).toBe(1700000001 * 1000);
  });

  test("encodes nanos in timestamps when present", () => {
    const bytes = Buffer.concat([
      stringField(1, "room-nanos"),
      lengthDelimited(4, timestamp(1700000000, 500_000_000)), // .5s
    ]);
    const result = decodeMetricsRecordingHeader(new Uint8Array(bytes));
    expect(result.startedAt?.getTime()).toBe(1700000000 * 1000 + 500);
  });

  test("treats a zero (0,0) timestamp as null rather than epoch 0", () => {
    const bytes = Buffer.concat([
      stringField(1, "room-zero"),
      lengthDelimited(4, timestamp(0)),
    ]);
    const result = decodeMetricsRecordingHeader(new Uint8Array(bytes));
    expect(result.startedAt).toBeNull();
  });

  test("drops empty-key string map entries", () => {
    // Defensive: a malformed map entry with no key shouldn't pollute the tag
    // bag with an empty-string key.
    const bytes = Buffer.concat([
      stringField(1, "room-defensive"),
      lengthDelimited(5, stringField(2, "value-without-key")),
    ]);
    const result = decodeMetricsRecordingHeader(new Uint8Array(bytes));
    expect(result.roomTags).toEqual({});
  });
});

// ─── decodeOtlpLogsRequest ──────────────────────────────────────────────────

describe("decodeOtlpLogsRequest", () => {
  function jsonLogsRequest(records: Array<{ body: string; attrs?: Record<string, unknown> }>): unknown {
    return {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: records.map((r) => ({
                body: { stringValue: r.body },
                attributes: Object.entries(r.attrs ?? {}).map(([key, value]) => ({
                  key,
                  value: jsonValue(value),
                })),
              })),
            },
          ],
        },
      ],
    };
  }

  function jsonValue(value: unknown): Record<string, unknown> {
    if (typeof value === "string") return { stringValue: value };
    if (typeof value === "boolean") return { boolValue: value };
    if (typeof value === "number" && Number.isInteger(value)) return { intValue: value };
    if (typeof value === "number") return { doubleValue: value };
    if (Array.isArray(value)) {
      return { arrayValue: { values: value.map(jsonValue) } };
    }
    if (value && typeof value === "object") {
      const kvList = Object.entries(value as Record<string, unknown>).map(([k, v]) => ({
        key: k,
        value: jsonValue(v),
      }));
      return { kvlistValue: { values: kvList } };
    }
    return { stringValue: "" };
  }

  test("decodes OTLP/JSON when content-type indicates JSON", () => {
    const json = jsonLogsRequest([
      { body: "session report", attrs: { room_id: "room-json", agent_name: "agent" } },
    ]);
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    const logs = decodeOtlpLogsRequest(bytes, null, "application/json");
    expect(logs).toHaveLength(1);
    expect(logs[0].body).toBe("session report");
    expect(logs[0].attributes.room_id).toBe("room-json");
  });

  test("sniffs JSON when content-type is missing", () => {
    const json = jsonLogsRequest([{ body: "tag", attrs: { room_id: "room-sniff" } }]);
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    // Pass undefined content-type — the decoder should fall back to peeking
    // at the first non-whitespace byte to detect '{' / '['.
    const logs = decodeOtlpLogsRequest(bytes, null, null);
    expect(logs).toHaveLength(1);
    expect(logs[0].body).toBe("tag");
    expect(logs[0].attributes.room_id).toBe("room-sniff");
  });

  test("decompresses gzipped JSON bodies (content-encoding: gzip)", () => {
    // Real LiveKit telemetry uploads usually land gzipped — protocol
    // exporters compress by default. The decoder must transparently
    // gunzip before content sniffing.
    const json = jsonLogsRequest([
      { body: "session report", attrs: { room_id: "room-gzip" } },
    ]);
    const compressed = gzipSync(Buffer.from(JSON.stringify(json), "utf8"));
    const logs = decodeOtlpLogsRequest(
      new Uint8Array(compressed),
      "gzip",
      "application/json",
    );
    expect(logs).toHaveLength(1);
    expect(logs[0].body).toBe("session report");
    expect(logs[0].attributes.room_id).toBe("room-gzip");
  });

  test("rejects a gzip bomb instead of allocating the full output", () => {
    // 128 MiB of zeros compresses to a tiny payload but blows past the
    // 64 MiB decompression cap — the decoder must throw rather than
    // materialize the whole buffer (zip-bomb DoS).
    const bomb = gzipSync(Buffer.alloc(128 * 1024 * 1024, 0));
    expect(bomb.length).toBeLessThan(200 * 1024); // genuinely small on the wire
    expect(() =>
      decodeOtlpLogsRequest(new Uint8Array(bomb), "gzip", "application/json"),
    ).toThrow();
  });

  test("returns empty array for an empty resourceLogs envelope", () => {
    const json = { resourceLogs: [] };
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    const logs = decodeOtlpLogsRequest(bytes, null, "application/json");
    expect(logs).toEqual([]);
  });

  test("normalizes JSON-string attribute values (Python SDK Tagger emits some attrs as stringified JSON)", () => {
    const json = jsonLogsRequest([
      {
        body: "session report",
        attrs: {
          room_id: "room-string-json",
          // Python Tagger sometimes emits structured values pre-serialized
          // as strings. The decoder pipes raw values through; downstream
          // (`raw-report.ts::parseJsonValue`) re-parses them. Here we only
          // assert the raw passthrough.
          "session.report": '{"options":{"max":3}}',
        },
      },
    ]);
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    const logs = decodeOtlpLogsRequest(bytes, null, "application/json");
    expect(logs).toHaveLength(1);
    expect(logs[0].attributes["session.report"]).toBe('{"options":{"max":3}}');
  });
});
