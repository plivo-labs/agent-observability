// AO Simulation Engine — Pipecat conversation history (sm:{sessionID}).
//
// Port of the reference worker history_writer.go. Each turn the engine appends to a Redis LIST keyed
// `sm:{flowRunUUID}` so the livekit CXAgent at /turn sees prior context. NOTE: `sm:` is Pipecat's
// own key convention (what livekit / Sentinel read) — it is deliberately NOT under SIM_REDIS_PREFIX.
// Turn shape: {user:{content,role,meta_data}, assistant:{content:{intent,variables,message},role,meta_data}}.

import type { RedisClient } from "../queue/redis.js";

// Atomic assistant patch (history_writer.go:12): LINDEX → cjson.decode → set assistant → LSET.
const PATCH_ASSISTANT_LUA = `
local current = redis.call('LINDEX', KEYS[1], tonumber(ARGV[1]))
if not current then return {0, "not found"} end
local obj = cjson.decode(current)
obj["assistant"] = cjson.decode(ARGV[2])
redis.call('LSET', KEYS[1], tonumber(ARGV[1]), cjson.encode(obj))
return {1, "ok"}
`;

const smKey = (sessionId: string): string => `sm:${sessionId}`;

/** RPUSH a user-only turn; returns its 0-based index (so the assistant reply can be patched in later). */
export async function writeUserTurn(
  redis: RedisClient,
  sessionId: string,
  nodeUuid: string,
  userMessage: string,
): Promise<number> {
  const turn = {
    user: { content: userMessage, role: "user", meta_data: { timestamp: Date.now(), node_uuid: nodeUuid } },
  };
  const listLen = await redis.rpush(smKey(sessionId), JSON.stringify(turn));
  return listLen - 1;
}

/** Atomically patch the assistant field into the turn at `index` (LINDEX→decode→LSET, like Pipecat). */
export async function patchAssistantResponse(
  redis: RedisClient,
  sessionId: string,
  index: number,
  nodeUuid: string,
  intent: string,
  variables: Record<string, unknown>,
  message: string,
): Promise<void> {
  const assistant = {
    content: { intent, variables, message },
    role: "assistant",
    meta_data: { timestamp: Date.now(), node_uuid: nodeUuid },
  };
  const result = (await redis.eval(
    PATCH_ASSISTANT_LUA,
    1,
    smKey(sessionId),
    String(index),
    JSON.stringify(assistant),
  )) as [number, string];
  if (Number(result[0]) === 0) throw new Error(`turn not found at index ${index}`);
}

/** RPUSH an assistant-only turn (node switches, where there is no paired user message). */
export async function writeAssistantTurn(
  redis: RedisClient,
  sessionId: string,
  nodeUuid: string,
  intent: string,
  variables: Record<string, unknown>,
  message: string,
): Promise<void> {
  const turn = {
    assistant: {
      content: { intent, variables, message },
      role: "assistant",
      meta_data: { timestamp: Date.now(), node_uuid: nodeUuid },
    },
  };
  await redis.rpush(smKey(sessionId), JSON.stringify(turn));
}

/** Set the TTL on the sm:{sessionID} list. */
export async function setSessionTTL(redis: RedisClient, sessionId: string, ttlSeconds: number): Promise<void> {
  await redis.expire(smKey(sessionId), ttlSeconds);
}
