import { describe, test, expect, afterAll } from "bun:test";
import { Redis } from "ioredis";
import {
  xaddEvent,
  getFlowJson,
  incrementAndCheckCompletion,
  flowJsonKey,
  expectedCountKey,
  resultsKey,
  processedCountKey,
  completedKey,
} from "../src/sim-engine/queue/redis.js";

// Integration test for the surviving Redis write primitives. Run against a reachable Redis:
//   REDIS_URL=redis://127.0.0.1:6379 bun test tests-integration/sim-queue-redis.test.ts
// Skips cleanly when no Redis is reachable.

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

async function probe(): Promise<Redis | null> {
  const c = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    await c.connect();
    await c.ping();
    return c;
  } catch {
    c.disconnect();
    return null;
  }
}

const client = await probe();
const suite = client ? describe : describe.skip;
if (!client) console.warn(`[sim-queue-redis] no Redis at ${REDIS_URL} — skipping integration suite`);

afterAll(async () => {
  if (client) await client.quit();
});

describe("redis key builders (pure)", () => {
  test("default prefix (SIM_EVAL) + the literal {run_uuid} cluster hash tag on all 5 keys", () => {
    const u = "run-123";
    expect(flowJsonKey(u)).toBe("SIM_EVAL:{run-123}:FLOW_JSON");
    expect(expectedCountKey(u)).toBe("SIM_EVAL:{run-123}:SCENARIO_EXPECTED_COUNT");
    expect(resultsKey(u)).toBe("SIM_EVAL:{run-123}:RESULTS");
    expect(processedCountKey(u)).toBe("SIM_EVAL:{run-123}:SCENARIO_PROCESSED_COUNT");
    expect(completedKey(u)).toBe("SIM_EVAL:{run-123}:SCENARIO_COMPLETED");
  });

  test("honors an explicit prefix override (OSS deploy with its own Redis)", () => {
    const u = "run-123";
    expect(flowJsonKey(u, "OSS_SIM")).toBe("OSS_SIM:{run-123}:FLOW_JSON");
    expect(expectedCountKey(u, "OSS_SIM")).toBe("OSS_SIM:{run-123}:SCENARIO_EXPECTED_COUNT");
    expect(resultsKey(u, "OSS_SIM")).toBe("OSS_SIM:{run-123}:RESULTS");
    expect(processedCountKey(u, "OSS_SIM")).toBe("OSS_SIM:{run-123}:SCENARIO_PROCESSED_COUNT");
    expect(completedKey(u, "OSS_SIM")).toBe("OSS_SIM:{run-123}:SCENARIO_COMPLETED");
  });
});

suite("redis queue I/O (integration)", () => {
  const redis = client!;

  test("xaddEvent appends a {type,data} entry wrapped in the standard envelope", async () => {
    const u = crypto.randomUUID();
    const id = await xaddEvent(redis, u, "scenario_started", { scenario_id: "s0", scenario_index: 0 });
    expect(id).toBeTruthy();

    // Read the raw entry back via XRANGE (the engine writes the stream; it does not read it here).
    const entries = (await redis.call("XRANGE", resultsKey(u), "-", "+")) as [string, string[]][];
    expect(entries.length).toBe(1);

    const [, fields] = entries[0]!;
    const map: Record<string, string> = {};
    for (let i = 0; i + 1 < fields.length; i += 2) map[fields[i]!] = fields[i + 1]!;
    expect(map.type).toBe("scenario_started");

    const data = JSON.parse(map.data!);
    expect(data.simulation_run_uuid).toBe(u);
    expect(data.event_version).toBe(1);
    expect(data.event_data).toEqual({ scenario_id: "s0", scenario_index: 0 });

    await redis.del(resultsKey(u));
  });

  test("getFlowJson returns the seeded flow and throws when absent", async () => {
    const u = crypto.randomUUID();
    await redis.set(flowJsonKey(u), '{"nodes":[{"id":"n1"}]}');
    expect(await getFlowJson(redis, u)).toBe('{"nodes":[{"id":"n1"}]}');
    await redis.del(flowJsonKey(u));
    await expect(getFlowJson(redis, u)).rejects.toThrow(/flow JSON not found/);
  });

  test("incrementAndCheckCompletion fires completedByThisCall exactly once at the expected count", async () => {
    const u = crypto.randomUUID();
    await redis.set(expectedCountKey(u), "3");
    const r1 = await incrementAndCheckCompletion(redis, u);
    const r2 = await incrementAndCheckCompletion(redis, u);
    const r3 = await incrementAndCheckCompletion(redis, u);
    const r4 = await incrementAndCheckCompletion(redis, u);
    expect([r1.processed, r2.processed, r3.processed, r4.processed]).toEqual([1, 2, 3, 4]);
    expect([
      r1.completedByThisCall,
      r2.completedByThisCall,
      r3.completedByThisCall,
      r4.completedByThisCall,
    ]).toEqual([false, false, true, false]);
    await redis.del(expectedCountKey(u), processedCountKey(u), completedKey(u));
  });
});
