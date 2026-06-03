import { upsertAgent } from "../agents/upsert.js";
import {
  applySessionTagMetadata,
  insertLiveKitEvaluation,
  mergeSessionRawReport,
  upsertSessionOutcome,
  upsertSessionTag,
} from "../db.js";
import type { DecodedOtlpLog } from "./protobuf.js";
import { parseJsonValue } from "../raw-report.js";

interface PersistResult {
  tags: number;
  evaluations: number;
  outcomes: number;
}

interface RawReportPatch extends Record<string, unknown> {
  options?: Record<string, unknown>;
  events?: Array<Record<string, unknown>>;
  tags?: string[];
  agent_id?: string;
  agent_name?: string;
  sdk_version?: string;
  usage?: unknown[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  const parsed = parseJsonValue(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function asArray(value: unknown): unknown[] | null {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed : null;
}

function sessionIdFor(log: DecodedOtlpLog): string | null {
  const attrs = {
    ...log.resourceAttributes,
    ...log.scopeAttributes,
    ...log.attributes,
  };
  return asString(attrs.room_id) ??
    asString(attrs.roomID) ??
    asString(attrs.session_id) ??
    asString(attrs.job_id);
}

function normalizeTimestamp(date: Date | null): Date | null {
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function timestampSeconds(date: Date | null): number | null {
  return date ? date.getTime() / 1000 : null;
}

function parseTimestampSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  }
  return null;
}

function roleToLower(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.toLowerCase() : undefined;
}

function textFromContentPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }
  const record = asRecord(part);
  const text = asString(record?.text);
  return text ?? "";
}

function normalizeChatItem(chatItem: Record<string, unknown>): Record<string, unknown> {
  const message = asRecord(chatItem.message);
  if (message) {
    const content = Array.isArray(message.content)
      ? message.content.map(textFromContentPart).filter((part) => part.length > 0)
      : [];
    return {
      ...message,
      type: "message",
      role: roleToLower(message.role) ?? message.role,
      content,
    };
  }

  const handoff = asRecord(chatItem.agent_handoff);
  if (handoff) {
    return {
      ...handoff,
      type: "agent_handoff",
    };
  }

  const functionCall = asRecord(chatItem.function_call);
  if (functionCall) {
    return {
      ...functionCall,
      type: "function_call",
    };
  }

  const functionCallOutput = asRecord(chatItem.function_call_output);
  if (functionCallOutput) {
    return {
      ...functionCallOutput,
      type: "function_call_output",
    };
  }

  return chatItem;
}

function eventFromChatItem(log: DecodedOtlpLog): Record<string, unknown> | null {
  const chatItem = asRecord(log.attributes["chat.item"]);
  if (!chatItem) {
    return null;
  }

  const item = normalizeChatItem(chatItem);
  const createdAt = parseTimestampSeconds(item.created_at) ?? timestampSeconds(log.timestamp);

  return {
    type: "conversation_item_added",
    created_at: createdAt,
    item,
  };
}

function mergeRawReportPatch(
  patches: Map<string, RawReportPatch>,
  sessionId: string,
  patch: RawReportPatch,
): void {
  const existing = patches.get(sessionId) ?? {};
  patches.set(sessionId, {
    ...existing,
    ...patch,
    events: [
      ...(existing.events ?? []),
      ...(patch.events ?? []),
    ],
  });
}

async function persistTag(
  sessionId: string,
  name: string,
  metadata: Record<string, unknown> | null,
  observedAt: Date | null,
): Promise<void> {
  await upsertSessionTag({
    sessionId,
    name,
    metadata,
    source: "livekit_otlp",
    observedAt,
  });
  await applySessionTagMetadata(sessionId, [{ name, metadata }]);
}

// Per-log dispatch context. Each handler reads the decoded log plus the
// resolved sessionId/observedAt, and may bump the running `result`
// counters or stage a raw_report patch into `rawReportPatches`.
interface OtlpHandlerCtx {
  log: DecodedOtlpLog;
  sessionId: string;
  observedAt: Date | null;
  result: PersistResult;
  rawReportPatches: Map<string, RawReportPatch>;
}

type OtlpHandler = (ctx: OtlpHandlerCtx) => Promise<void>;

async function handleSessionReport({ log, sessionId, observedAt, result, rawReportPatches }: OtlpHandlerCtx): Promise<void> {
  const rawSessionReport = asRecord(log.attributes["session.report"]);
  const options = asRecord(log.attributes["session.options"]);
  const tags = asStringArray(log.attributes["session.tags"]);
  const agentId = asString(log.attributes.agent_id);
  const agentName = asString(log.attributes.agent_name);
  const sdkVersion = asString(log.attributes.sdk_version);
  const usage = asArray(log.attributes.usage);
  // Upsert the agent so the FK on (agent_id, account_id) is
  // satisfied when the session row eventually lands. account_id
  // isn't on this OTLP record; the '' bucket gets used here, and a
  // subsequent OTLP "tag" with account_id:<value> or the multipart
  // recording report can re-upsert with the real account.
  if (agentId) {
    await upsertAgent({ agentId, accountId: null, agentName });
  }
  mergeRawReportPatch(rawReportPatches, sessionId, {
    ...(rawSessionReport ?? {}),
    ...(options ? { options } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    ...(agentName ? { agent_name: agentName } : {}),
    ...(sdkVersion ? { sdk_version: sdkVersion } : {}),
    ...(usage ? { usage } : {}),
  });

  for (const tagName of tags) {
    await persistTag(sessionId, tagName, null, observedAt);
    result.tags += 1;
  }
}

async function handleChatItem({ log, sessionId, rawReportPatches }: OtlpHandlerCtx): Promise<void> {
  const event = eventFromChatItem(log);
  if (event) {
    mergeRawReportPatch(rawReportPatches, sessionId, { events: [event] });
  }
}

async function handleTag({ log, sessionId, observedAt, result }: OtlpHandlerCtx): Promise<void> {
  const tag = asRecord(log.attributes.tag);
  const name = asString(tag?.name);
  if (!name) {
    return;
  }
  const metadata = asRecord(tag?.metadata);
  await persistTag(sessionId, name, metadata, observedAt);
  result.tags += 1;
}

async function handleEvaluation({ log, sessionId, observedAt, result }: OtlpHandlerCtx): Promise<void> {
  const evaluation = asRecord(log.attributes.evaluation);
  if (!evaluation) {
    return;
  }
  const judgeName = asString(evaluation.name);
  if (!judgeName) {
    return;
  }
  await insertLiveKitEvaluation({
    sessionId,
    source: "livekit_tagger",
    judgeName,
    tag: asString(evaluation.tag),
    verdict: asString(evaluation.verdict),
    reasoning: asString(evaluation.reasoning),
    instructions: asString(evaluation.instructions),
    observedAt,
    raw: evaluation,
  });
  result.evaluations += 1;
}

async function handleOutcome({ log, sessionId, observedAt, result }: OtlpHandlerCtx): Promise<void> {
  const outcome = asRecord(log.attributes.outcome);
  if (!outcome) {
    return;
  }
  const name = asString(outcome?.outcome);
  if (!name) {
    return;
  }
  await upsertSessionOutcome({
    sessionId,
    source: "livekit_tagger",
    outcome: name,
    reason: asString(outcome?.reason),
    observedAt,
    raw: outcome,
  });
  result.outcomes += 1;
}

// String-keyed dispatch on log.body. Replaces the former linear
// if-chain; an unknown body is simply ignored (no handler entry).
const OTLP_HANDLERS: Record<string, OtlpHandler> = {
  "session report": handleSessionReport,
  "chat item": handleChatItem,
  "tag": handleTag,
  "evaluation": handleEvaluation,
  "outcome": handleOutcome,
};

export async function persistLiveKitOtlpLogs(logs: DecodedOtlpLog[]): Promise<PersistResult> {
  const result: PersistResult = { tags: 0, evaluations: 0, outcomes: 0 };
  const rawReportPatches = new Map<string, RawReportPatch>();

  for (const log of logs) {
    const sessionId = sessionIdFor(log);
    if (!sessionId) {
      continue;
    }

    const observedAt = normalizeTimestamp(log.timestamp);
    const body = asString(log.body);
    const handler = body ? OTLP_HANDLERS[body] : undefined;
    if (!handler) {
      continue;
    }

    await handler({ log, sessionId, observedAt, result, rawReportPatches });
  }

  for (const [sessionId, patch] of rawReportPatches) {
    await mergeSessionRawReport({ sessionId, patch });
  }

  return result;
}
