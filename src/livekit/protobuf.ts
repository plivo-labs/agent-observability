import { gunzipSync } from "node:zlib";

// Upper bound on a decompressed OTLP body. gzip can expand ~1000x, so an
// uncapped gunzip turns a tiny upload into a multi-GB allocation that
// blocks the event loop and OOM-kills the process (zip bomb). 64 MiB is
// far above any legitimate OTLP log batch.
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

export interface LiveKitRecordingHeader {
  roomId: string;
  startedAt: Date | null;
  roomTags: Record<string, string>;
  roomName: string | null;
  roomStartedAt: Date | null;
}

export interface DecodedOtlpLog {
  body: unknown;
  attributes: Record<string, unknown>;
  resourceAttributes: Record<string, unknown>;
  scopeAttributes: Record<string, unknown>;
  scopeName: string | null;
  timestamp: Date | null;
}

class ProtoReader {
  private pos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  readTag(): { field: number; wire: number } {
    const tag = Number(this.readVarint());
    return { field: tag >> 3, wire: tag & 0x7 };
  }

  readVarint(): bigint {
    let shift = 0n;
    let result = 0n;
    // A 64-bit varint is at most 10 bytes. Without this cap, a crafted body
    // of all-continuation bytes (0xff…) makes the loop run over the whole
    // buffer doing growing BigInt math — CPU burn on malformed input.
    let bytesRead = 0;
    while (!this.done) {
      if (bytesRead >= 10) {
        throw new Error("varint overflow");
      }
      const byte = BigInt(this.bytes[this.pos++]);
      bytesRead++;
      result |= (byte & 0x7fn) << shift;
      if ((byte & 0x80n) === 0n) {
        return result;
      }
      shift += 7n;
    }
    throw new Error("truncated varint");
  }

  readBool(): boolean {
    return this.readVarint() !== 0n;
  }

  readLengthDelimited(): Uint8Array {
    const length = Number(this.readVarint());
    const end = this.pos + length;
    if (end > this.bytes.length) {
      throw new Error("truncated length-delimited field");
    }
    const out = this.bytes.subarray(this.pos, end);
    this.pos = end;
    return out;
  }

  readString(): string {
    return new TextDecoder().decode(this.readLengthDelimited());
  }

  readFixed64(): bigint {
    if (this.pos + 8 > this.bytes.length) {
      throw new Error("truncated fixed64 field");
    }
    let value = 0n;
    for (let i = 0; i < 8; i += 1) {
      value |= BigInt(this.bytes[this.pos + i]) << BigInt(8 * i);
    }
    this.pos += 8;
    return value;
  }

  readDouble(): number {
    const start = this.pos;
    if (start + 8 > this.bytes.length) {
      throw new Error("truncated double field");
    }
    this.pos += 8;
    return new DataView(this.bytes.buffer, this.bytes.byteOffset + start, 8).getFloat64(0, true);
  }

  readFixed32(): number {
    const start = this.pos;
    if (start + 4 > this.bytes.length) {
      throw new Error("truncated fixed32 field");
    }
    this.pos += 4;
    return new DataView(this.bytes.buffer, this.bytes.byteOffset + start, 4).getUint32(0, true);
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.readVarint();
        return;
      case 1:
        this.pos += 8;
        return;
      case 2:
        this.readLengthDelimited();
        return;
      case 5:
        this.pos += 4;
        return;
      default:
        throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
}

function timestampToDate(seconds: bigint, nanos: number): Date | null {
  if (seconds === 0n && nanos === 0) {
    return null;
  }
  return new Date(Number(seconds * 1000n) + Math.floor(nanos / 1_000_000));
}

function decodeTimestamp(bytes: Uint8Array): Date | null {
  const reader = new ProtoReader(bytes);
  let seconds = 0n;
  let nanos = 0;
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 0) {
      seconds = reader.readVarint();
    } else if (field === 2 && wire === 0) {
      nanos = Number(reader.readVarint());
    } else {
      reader.skip(wire);
    }
  }
  return timestampToDate(seconds, nanos);
}

function decodeStringMapEntry(bytes: Uint8Array): [string, string] | null {
  const reader = new ProtoReader(bytes);
  let key = "";
  let value = "";
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) {
      key = reader.readString();
    } else if (field === 2 && wire === 2) {
      value = reader.readString();
    } else {
      reader.skip(wire);
    }
  }
  return key ? [key, value] : null;
}

export function decodeMetricsRecordingHeader(bytes: Uint8Array): LiveKitRecordingHeader {
  const reader = new ProtoReader(bytes);
  const header: LiveKitRecordingHeader = {
    roomId: "",
    startedAt: null,
    roomTags: {},
    roomName: null,
    roomStartedAt: null,
  };

  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) {
      header.roomId = reader.readString();
    } else if (field === 4 && wire === 2) {
      header.startedAt = decodeTimestamp(reader.readLengthDelimited());
    } else if (field === 5 && wire === 2) {
      const entry = decodeStringMapEntry(reader.readLengthDelimited());
      if (entry) {
        header.roomTags[entry[0]] = entry[1];
      }
    } else if (field === 6 && wire === 2) {
      header.roomName = reader.readString();
    } else if (field === 7 && wire === 2) {
      header.roomStartedAt = decodeTimestamp(reader.readLengthDelimited());
    } else {
      reader.skip(wire);
    }
  }

  return header;
}

function decodeAnyValue(bytes: Uint8Array): unknown {
  const reader = new ProtoReader(bytes);
  let value: unknown = null;
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) {
      value = reader.readString();
    } else if (field === 2 && wire === 0) {
      value = reader.readBool();
    } else if (field === 3 && wire === 0) {
      value = Number(reader.readVarint());
    } else if (field === 4 && wire === 1) {
      value = reader.readDouble();
    } else if (field === 5 && wire === 2) {
      value = decodeArrayValue(reader.readLengthDelimited());
    } else if (field === 6 && wire === 2) {
      value = decodeKeyValueList(reader.readLengthDelimited());
    } else if (field === 7 && wire === 2) {
      value = reader.readLengthDelimited();
    } else {
      reader.skip(wire);
    }
  }
  return value;
}

function decodeArrayValue(bytes: Uint8Array): unknown[] {
  const reader = new ProtoReader(bytes);
  const values: unknown[] = [];
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) {
      values.push(decodeAnyValue(reader.readLengthDelimited()));
    } else {
      reader.skip(wire);
    }
  }
  return values;
}

function decodeKeyValue(bytes: Uint8Array): [string, unknown] | null {
  const reader = new ProtoReader(bytes);
  let key = "";
  let value: unknown = null;
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) {
      key = reader.readString();
    } else if (field === 2 && wire === 2) {
      value = decodeAnyValue(reader.readLengthDelimited());
    } else {
      reader.skip(wire);
    }
  }
  return key ? [key, value] : null;
}

function decodeKeyValueList(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = {};
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) {
      const entry = decodeKeyValue(reader.readLengthDelimited());
      if (entry) {
        out[entry[0]] = entry[1];
      }
    } else {
      reader.skip(wire);
    }
  }
  return out;
}

function decodeResource(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const attributes: Record<string, unknown> = {};
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) {
      const entry = decodeKeyValue(reader.readLengthDelimited());
      if (entry) {
        attributes[entry[0]] = entry[1];
      }
    } else {
      reader.skip(wire);
    }
  }
  return attributes;
}

function decodeScope(bytes: Uint8Array): { name: string | null; attributes: Record<string, unknown> } {
  const reader = new ProtoReader(bytes);
  const scope = { name: null as string | null, attributes: {} as Record<string, unknown> };
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) {
      scope.name = reader.readString();
    } else if (field === 3 && wire === 2) {
      const entry = decodeKeyValue(reader.readLengthDelimited());
      if (entry) {
        scope.attributes[entry[0]] = entry[1];
      }
    } else {
      reader.skip(wire);
    }
  }
  return scope;
}

function decodeLogRecord(bytes: Uint8Array): Pick<DecodedOtlpLog, "body" | "attributes" | "timestamp"> {
  const reader = new ProtoReader(bytes);
  const attributes: Record<string, unknown> = {};
  let body: unknown = null;
  let timestampNs = 0n;

  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 1) {
      timestampNs = reader.readFixed64();
    } else if (field === 5 && wire === 2) {
      body = decodeAnyValue(reader.readLengthDelimited());
    } else if (field === 6 && wire === 2) {
      const entry = decodeKeyValue(reader.readLengthDelimited());
      if (entry) {
        attributes[entry[0]] = entry[1];
      }
    } else {
      reader.skip(wire);
    }
  }

  const timestamp = timestampNs > 0n ? new Date(Number(timestampNs / 1_000_000n)) : null;
  return { body, attributes, timestamp };
}

function decodeScopeLogs(bytes: Uint8Array, resourceAttributes: Record<string, unknown>): DecodedOtlpLog[] {
  const reader = new ProtoReader(bytes);
  let scopeName: string | null = null;
  let scopeAttributes: Record<string, unknown> = {};
  const logs: DecodedOtlpLog[] = [];

  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) {
      const scope = decodeScope(reader.readLengthDelimited());
      scopeName = scope.name;
      scopeAttributes = scope.attributes;
    } else if (field === 2 && wire === 2) {
      const record = decodeLogRecord(reader.readLengthDelimited());
      logs.push({
        ...record,
        resourceAttributes,
        scopeAttributes,
        scopeName,
      });
    } else {
      reader.skip(wire);
    }
  }

  return logs;
}

function decodeResourceLogs(bytes: Uint8Array): DecodedOtlpLog[] {
  const reader = new ProtoReader(bytes);
  let resourceAttributes: Record<string, unknown> = {};
  const pendingScopeLogs: Uint8Array[] = [];

  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) {
      resourceAttributes = decodeResource(reader.readLengthDelimited());
    } else if (field === 2 && wire === 2) {
      pendingScopeLogs.push(reader.readLengthDelimited());
    } else {
      reader.skip(wire);
    }
  }

  return pendingScopeLogs.flatMap((scopeLogs) => decodeScopeLogs(scopeLogs, resourceAttributes));
}

function maybeGunzip(bytes: Uint8Array, contentEncoding?: string | null): Uint8Array {
  const isGzip = contentEncoding?.toLowerCase().includes("gzip") ||
    (bytes[0] === 0x1f && bytes[1] === 0x8b);
  if (!isGzip) {
    return bytes;
  }
  // maxOutputLength makes zlib abort (and free the partial buffer) once the
  // decompressed size crosses the cap, instead of allocating it all first.
  return new Uint8Array(
    gunzipSync(Buffer.from(bytes), { maxOutputLength: MAX_DECOMPRESSED_BYTES }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJsonAnyValue(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return Boolean(value.boolValue);
  if ("intValue" in value) {
    const raw = value.intValue;
    if (typeof raw === "number") return raw;
    if (typeof raw === "string" && raw.length > 0) {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : raw;
    }
    return raw;
  }
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("bytesValue" in value) return value.bytesValue;
  if ("arrayValue" in value) {
    const arrayValue = isRecord(value.arrayValue) ? value.arrayValue : {};
    const values = Array.isArray(arrayValue.values) ? arrayValue.values : [];
    return values.map(decodeJsonAnyValue);
  }
  if ("kvlistValue" in value) {
    const kvlistValue = isRecord(value.kvlistValue) ? value.kvlistValue : {};
    const values = Array.isArray(kvlistValue.values) ? kvlistValue.values : [];
    const out: Record<string, unknown> = {};
    for (const item of values) {
      if (!isRecord(item) || typeof item.key !== "string") {
        continue;
      }
      out[item.key] = decodeJsonAnyValue(item.value);
    }
    return out;
  }

  return value;
}

function decodeJsonAttributes(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const item of value) {
      if (!isRecord(item) || typeof item.key !== "string") {
        continue;
      }
      out[item.key] = decodeJsonAnyValue(item.value);
    }
    return out;
  }

  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = decodeJsonAnyValue(item);
    }
    return out;
  }

  return {};
}

function timestampFromUnixNano(value: unknown): Date | null {
  if (typeof value === "string" && value.length > 0) {
    try {
      const nanos = BigInt(value);
      return nanos > 0n ? new Date(Number(nanos / 1_000_000n)) : null;
    } catch {
      return null;
    }
  }

  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(Math.floor(value / 1_000_000));
  }

  return null;
}

function decodeJsonScope(scope: unknown): { name: string | null; attributes: Record<string, unknown> } {
  const record = isRecord(scope) ? scope : {};
  return {
    name: typeof record.name === "string" ? record.name : null,
    attributes: decodeJsonAttributes(record.attributes),
  };
}

function decodeOtlpJsonLogsRequest(payload: unknown): DecodedOtlpLog[] {
  const root = isRecord(payload) ? payload : {};
  const resourceLogs = Array.isArray(root.resourceLogs) ? root.resourceLogs : [];
  const logs: DecodedOtlpLog[] = [];

  for (const resourceLog of resourceLogs) {
    if (!isRecord(resourceLog)) {
      continue;
    }
    const resource = isRecord(resourceLog.resource) ? resourceLog.resource : {};
    const resourceAttributes = decodeJsonAttributes(resource.attributes);
    const scopeLogs = Array.isArray(resourceLog.scopeLogs) ? resourceLog.scopeLogs : [];

    for (const scopeLog of scopeLogs) {
      if (!isRecord(scopeLog)) {
        continue;
      }
      const scope = decodeJsonScope(scopeLog.scope);
      const logRecords = Array.isArray(scopeLog.logRecords) ? scopeLog.logRecords : [];

      for (const record of logRecords) {
        if (!isRecord(record)) {
          continue;
        }
        logs.push({
          body: decodeJsonAnyValue(record.body),
          attributes: decodeJsonAttributes(record.attributes),
          resourceAttributes,
          scopeAttributes: scope.attributes,
          scopeName: scope.name,
          timestamp: timestampFromUnixNano(record.timeUnixNano) ?? timestampFromUnixNano(record.observedTimeUnixNano),
        });
      }
    }
  }

  return logs;
}

function looksLikeJson(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      continue;
    }
    return byte === 0x7b || byte === 0x5b;
  }
  return false;
}

export function decodeOtlpLogsRequest(
  bytes: Uint8Array,
  contentEncoding?: string | null,
  contentType?: string | null,
): DecodedOtlpLog[] {
  const body = maybeGunzip(bytes, contentEncoding);
  if (contentType?.toLowerCase().includes("json") || looksLikeJson(body)) {
    return decodeOtlpJsonLogsRequest(JSON.parse(new TextDecoder().decode(body)));
  }

  const reader = new ProtoReader(body);
  const logs: DecodedOtlpLog[] = [];

  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) {
      logs.push(...decodeResourceLogs(reader.readLengthDelimited()));
    } else {
      reader.skip(wire);
    }
  }

  return logs;
}
