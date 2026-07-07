import { upsertAgent } from "../agents/upsert.js";
import {
  applySessionTagMetadata,
  insertLiveKitEvaluation,
  mergeSessionRawReport,
  upsertSessionOutcome,
  upsertSessionTag,
  upsertSessionAgentConfig,
} from "../db.js";
import type { DecodedOtlpLog } from "./protobuf.js";
import { parseJsonValue } from "../raw-report.js";
import { sanitizeForLog } from "../response.js";

interface PersistResult {
  tags: number;
  evaluations: number;
  outcomes: number;
  agentConfigs: number;
  /** Records dropped because persisting them fails deterministically
   *  (constraint/shape errors) — visible in the ingest response so a sender
   *  can notice data it thinks was accepted actually wasn't. */
  skippedRecords: number;
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
  // Opaque per-utterance node reference the sender may attach so downstream
  // eval can group turns by the node that produced them. Correlates to a
  // node `ref` in the agent config; AO never interprets its value.
  const nodeRef = asString(log.attributes.node_ref) ?? asString(chatItem.node_ref);

  return {
    type: "conversation_item_added",
    created_at: createdAt,
    ...(nodeRef ? { node_ref: nodeRef } : {}),
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

// Reserved tag name: a client may deliver the agent config through the tag
// channel (name = AGENT_CONFIG_TAG, metadata = the config). The config is the
// eval opt-in; it's stored as agent config rather than a plain tag so it never
// pollutes the session's tag list. Namespaced ("observability." prefix) so the
// reserved name can't squat a tag a sender plausibly uses for its own
// purposes; "agent.config" is accepted as a legacy alias for early senders.
const AGENT_CONFIG_TAG = "observability.agent_config";
const AGENT_CONFIG_TAG_LEGACY = "agent.config";

async function handleTag({ log, sessionId, observedAt, result }: OtlpHandlerCtx): Promise<void> {
  const tag = asRecord(log.attributes.tag);
  const name = asString(tag?.name);
  if (!name) {
    return;
  }
  const metadata = asRecord(tag?.metadata);
  if (name === AGENT_CONFIG_TAG || name === AGENT_CONFIG_TAG_LEGACY) {
    const stored = await storeAgentConfig(sessionId, metadata, observedAt, result);
    if (!stored) {
      // Metadata didn't parse as an agent config — keep it as a plain tag
      // (visible, debuggable) instead of silently swallowing the record.
      console.warn(`[otlp] ${AGENT_CONFIG_TAG} tag without a valid config (session=${sessionId.slice(0, 64)}) — stored as a plain tag`);
      await persistTag(sessionId, name, metadata, observedAt);
      result.tags += 1;
    }
    return;
  }
  await persistTag(sessionId, name, metadata, observedAt);
  result.tags += 1;
}

// Caps on the judging surface one config can demand: each judged node costs
// ~5 LLM calls, so an unbounded config would let a single ingested session
// trigger an unbounded provider bill. Oversized configs are clamped (never
// rejected) and the truncation is logged.
const MAX_CONFIG_NODES = 150;
const MAX_NODE_LIST_ITEMS = 100; // intents / variables per node
const MAX_INSTRUCTIONS_CHARS = 50_000;

function clampAgentConfig(config: Record<string, unknown>): Record<string, unknown> {
  const nodes = Array.isArray(config.nodes) ? config.nodes : [];
  let clamped = false;
  const boundedNodes = nodes.slice(0, MAX_CONFIG_NODES).map((n) => {
    if (typeof n !== "object" || n === null) return n;
    const node = { ...(n as Record<string, unknown>) };
    if (typeof node.instructions === "string" && node.instructions.length > MAX_INSTRUCTIONS_CHARS) {
      node.instructions = node.instructions.slice(0, MAX_INSTRUCTIONS_CHARS);
      clamped = true;
    }
    for (const key of ["intents", "variables"]) {
      if (Array.isArray(node[key]) && (node[key] as unknown[]).length > MAX_NODE_LIST_ITEMS) {
        node[key] = (node[key] as unknown[]).slice(0, MAX_NODE_LIST_ITEMS);
        clamped = true;
      }
    }
    return node;
  });
  if (nodes.length > MAX_CONFIG_NODES) clamped = true;
  if (clamped) {
    console.warn(`[otlp] agent config clamped to ${MAX_CONFIG_NODES} nodes / ${MAX_NODE_LIST_ITEMS} intents+variables per node / ${MAX_INSTRUCTIONS_CHARS} instruction chars`);
  }
  return { ...config, nodes: boundedNodes };
}

/** Validate + store an agent config (from either the dedicated record or the
 *  reserved tag). Requires at least one node; otherwise ignored. Returns
 *  whether a config was stored. */
async function storeAgentConfig(
  sessionId: string,
  config: Record<string, unknown> | null,
  observedAt: Date | null,
  result: PersistResult,
): Promise<boolean> {
  if (!config || !Array.isArray(config.nodes) || config.nodes.length === 0) {
    return false;
  }
  await upsertSessionAgentConfig({ sessionId, config: clampAgentConfig(config), source: "livekit_otlp", observedAt });
  result.agentConfigs += 1;
  return true;
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

// Dedicated record path (a client that can emit a custom OTLP record body uses
// this; clients that can only emit tags use the reserved AGENT_CONFIG_TAG
// instead — both land in the same store via storeAgentConfig).
async function handleAgentConfig({ log, sessionId, observedAt, result }: OtlpHandlerCtx): Promise<void> {
  await storeAgentConfig(sessionId, asRecord(log.attributes["agent.config"]), observedAt, result);
}

// String-keyed dispatch on log.body. Replaces the former linear
// if-chain; an unknown body is simply ignored (no handler entry).
const OTLP_HANDLERS: Record<string, OtlpHandler> = {
  "session report": handleSessionReport,
  "chat item": handleChatItem,
  "tag": handleTag,
  "evaluation": handleEvaluation,
  "outcome": handleOutcome,
  // The eval opt-in: sessions that carry an agent config get judged by the
  // background eval sweeper; sessions without one are stored/displayed only.
  "agent config": handleAgentConfig,
};

/** True when a persist error is environmental (connection/timeout/outage) —
 *  the batch should abort and 503 so at-least-once senders retry. Everything
 *  else (constraint violations, invalid input, oversize values) fails the
 *  same way on every redelivery and is skipped per-record instead. Unknown
 *  errors default to transient: dropping data needs positive evidence. */
function isTransientPersistError(e: unknown): boolean {
  // Prefer the structured SQLSTATE that Postgres attaches to the error. Classes
  // 22 (data exception — incl. 22P05 jsonb NUL), 23 (integrity constraint) and
  // 42 (syntax/access) are DETERMINISTIC: the same record fails identically on
  // every redelivery, so it's skipped rather than 503-looping the batch.
  const code = (e as { code?: string })?.code ?? "";
  if (/^(22|23|42)/.test(code)) return false;
  if (code) return true; // any other coded error (e.g. class 08 connection) is transient
  // No SQLSTATE (non-Postgres throw) — fall back to matching the message text.
  const msg = (e as Error)?.message ?? "";
  const deterministic = /constraint|duplicate key|invalid input|value too long|out of range|null value|syntax|malformed|unsupported unicode|invalid byte sequence/i;
  return !deterministic.test(msg);
}

export async function persistLiveKitOtlpLogs(logs: DecodedOtlpLog[]): Promise<PersistResult> {
  const result: PersistResult = { tags: 0, evaluations: 0, outcomes: 0, agentConfigs: 0, skippedRecords: 0 };
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

    try {
      await handler({ log, sessionId, observedAt, result, rawReportPatches });
    } catch (e) {
      // Per-record isolation: a DETERMINISTIC persist failure (constraint /
      // shape / size — would fail identically on every redelivery) must not
      // poison the whole batch into an endless 503-retry loop; skip that one
      // record and keep going. Transient failures (connection/timeout) still
      // abort the batch so the route 503s and at-least-once senders retry.
      if (isTransientPersistError(e)) {
        throw e;
      }
      result.skippedRecords += 1;
      console.error(`[otlp] record skipped (deterministic persist error, body=${sanitizeForLog(body ?? "")}): ${sanitizeForLog((e as Error).message)}`);
    }
  }

  for (const [sessionId, patch] of rawReportPatches) {
    try {
      await mergeSessionRawReport({ sessionId, patch });
    } catch (e) {
      if (isTransientPersistError(e)) {
        throw e;
      }
      result.skippedRecords += 1;
      console.error(`[otlp] raw-report patch skipped (deterministic persist error): ${sanitizeForLog((e as Error).message)}`);
    }
  }

  return result;
}
