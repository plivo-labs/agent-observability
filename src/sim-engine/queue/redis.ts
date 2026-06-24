// AO Simulation Engine — Redis client + low-level write primitives.
//
// Redis I/O for the simulation engine: the client factories, the run-scoped key templates, the
// `xaddEvent` :RESULTS append (envelope byte-identical to the worker's), the FLOW_JSON read, and
// the atomic Lua completion gate. The engine WRITES the :RESULTS stream; it never reads it back
// (aiassist persists + relays). Ported from run_manager.go.
// Key templates match the worker's (`config/rediscachekey.go:25-36`), with a configurable prefix
// (SIM_REDIS_PREFIX, default SIM_EVAL — matches aiassist on Plivo; override for OSS); 3600s TTL.
//
// Why ioredis (not Bun.redis): prod Redis is CLUSTERED — the `SIM_EVAL:{run_uuid}:*` hash tags
// exist solely so the worker's 3-key Lua completion gate lands in one slot. ioredis has mature
// XADD, `.duplicate()`, and a real Cluster client; we need standalone (dev) AND Cluster
// (Plivo prod) from one code path.

import { Redis, Cluster } from "ioredis";
import { simEngineConfig } from "../config.js";

export type RedisClient = Redis | Cluster;

/** Stream + key TTL, matching aiassist + the worker (3600s). */
export const RESULTS_TTL_S = 3600;

// ── Key builders — the braces are LITERAL (a Redis Cluster hash tag), so all keys for one run
// hash to the same slot. e.g. SIM_EVAL:{<run_uuid>}:FLOW_JSON ──────────────────────────────
// `prefix` defaults to the configured SIM_REDIS_PREFIX (SIM_EVAL on Plivo to match aiassist on the
// shared Redis; override for OSS). Passable explicitly so the builders are pure + unit-testable.
export const flowJsonKey = (runUuid: string, prefix: string = simEngineConfig.simRedisPrefix): string =>
  `${prefix}:{${runUuid}}:FLOW_JSON`;
export const expectedCountKey = (runUuid: string, prefix: string = simEngineConfig.simRedisPrefix): string =>
  `${prefix}:{${runUuid}}:SCENARIO_EXPECTED_COUNT`;
export const resultsKey = (runUuid: string, prefix: string = simEngineConfig.simRedisPrefix): string =>
  `${prefix}:{${runUuid}}:RESULTS`;
// The worker's 3-key Lua completion-gate counters (consumed by the engine in Stage 3).
export const processedCountKey = (runUuid: string, prefix: string = simEngineConfig.simRedisPrefix): string =>
  `${prefix}:{${runUuid}}:SCENARIO_PROCESSED_COUNT`;
export const completedKey = (runUuid: string, prefix: string = simEngineConfig.simRedisPrefix): string =>
  `${prefix}:{${runUuid}}:SCENARIO_COMPLETED`;

export interface MakeRedisOptions {
  url?: string;
  cluster?: boolean;
}

/**
 * Construct a Redis client. Standalone by default; a Cluster client when `cluster` is set
 * (REDIS_CLUSTER=true in prod). The engine only WRITES the stream (XADD) + runs the Lua gate;
 * it never blocks on XREAD (aiassist relays), so no dedicated blocking client is needed.
 */
export function makeRedis(opts: MakeRedisOptions = {}): RedisClient {
  const url = opts.url ?? simEngineConfig.redisUrl;
  if (!url) throw new Error("REDIS_URL is not configured");
  const useCluster = opts.cluster ?? simEngineConfig.redisCluster;
  if (useCluster) {
    // A single seed URL is enough — the Cluster client discovers the rest of the nodes.
    return new Cluster([url]);
  }
  return new Redis(url);
}

// ── Writer (the engine's stream append primitive) ───────────────────────────────────────────

/** XADD one :RESULTS entry. Fields are exactly `type` + `data`, where data is the worker's envelope
 *  `{simulation_run_uuid, event_version, event_data}` (run_manager.go:101) — byte-identical so
 *  aiassist's persist + relay parse AO's stream unchanged. Refreshes the stream TTL each append. */
export async function xaddEvent(
  redis: RedisClient,
  runUuid: string,
  type: string,
  eventData: unknown,
): Promise<string | null> {
  const data = JSON.stringify({ simulation_run_uuid: runUuid, event_version: 1, event_data: eventData });
  const id = await redis.xadd(resultsKey(runUuid), "*", "type", type, "data", data);
  try {
    await redis.expire(resultsKey(runUuid), RESULTS_TTL_S);
  } catch {
    /* best-effort, mirrors the worker's ignored Expire error */
  }
  return id;
}

/** Read the flow JSON aiassist seeded for this run (worker GetFlowJSON, run_manager.go:236). */
export async function getFlowJson(redis: RedisClient, runUuid: string): Promise<string> {
  const val = await redis.get(flowJsonKey(runUuid));
  if (!val) throw new Error(`flow JSON not found for run ${runUuid}`);
  return val;
}

// Atomic completion gate (worker completionLuaScript, run_manager.go:47). Keys:
// [processed, expected, completed]. INCRs `processed`; the FIRST call to reach `expected`
// SETNXes `completed` → returns completedByThisCall=true exactly once, so simulation_completed
// is emitted once even under concurrent workers / at-least-once SQS redelivery.
const COMPLETION_LUA = `
local processedKey = KEYS[1]
local expectedKey = KEYS[2]
local completedKey = KEYS[3]

local newCount = redis.call('INCR', processedKey)
redis.call('EXPIRE', processedKey, 3600)
local expected = redis.call('GET', expectedKey)
if expected and tonumber(newCount) >= tonumber(expected) then
    local wasSet = redis.call('SETNX', completedKey, '1')
    if wasSet == 1 then
        redis.call('EXPIRE', completedKey, 3600)
        return {newCount, 1}
    end
end
return {newCount, 0}
`;

export interface CompletionResult {
  /** Processed-scenario count after this increment. */
  processed: number;
  /** True only for the single call that pushed the count to `expected` (→ emit simulation_completed). */
  completedByThisCall: boolean;
}

/** Increment the processed count + atomically check run completion (worker IncrementAndCheckCompletion). */
export async function incrementAndCheckCompletion(
  redis: RedisClient,
  runUuid: string,
): Promise<CompletionResult> {
  const result = (await redis.eval(
    COMPLETION_LUA,
    3,
    processedCountKey(runUuid),
    expectedCountKey(runUuid),
    completedKey(runUuid),
  )) as [number, number];
  return { processed: Number(result[0]), completedByThisCall: Number(result[1]) === 1 };
}
