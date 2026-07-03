import { describe, test, expect, afterAll } from "bun:test";
import { Redis } from "ioredis";
import { resultsKey } from "../src/sim-engine/queue/redis.js";
import {
  emitScenarioStarted,
  emitTurnCompleted,
  emitScenarioCompleted,
  emitSimulationCompleted,
  emitSimulationError,
  SIM_ERROR,
} from "../src/sim-engine/run-engine/stream.js";

// Stage 3: the typed :RESULTS emitters write the worker's envelope + event_data byte-for-byte.
// Needs a reachable Redis: REDIS_URL=redis://127.0.0.1:6379 bun test tests-integration/sim-engine-stream.test.ts

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
if (!client) console.warn(`[sim-engine-stream] no Redis at ${REDIS_URL} — skipping integration suite`);

afterAll(async () => {
  if (client) await client.quit();
});

async function readEntries(redis: Redis, u: string): Promise<{ type: string; data: any }[]> {
  const entries = (await redis.call("XRANGE", resultsKey(u), "-", "+")) as [string, string[]][];
  return entries.map(([, fields]) => {
    const map: Record<string, string> = {};
    for (let i = 0; i + 1 < fields.length; i += 2) map[fields[i]!] = fields[i + 1]!;
    return { type: map.type!, data: JSON.parse(map.data!) };
  });
}

suite("typed :RESULTS emitters (integration)", () => {
  const redis = client!;

  test("each emitter writes the worker envelope (simulation_run_uuid + event_version) + event_data", async () => {
    const u = crypto.randomUUID();
    await emitScenarioStarted(redis, u, {
      scenario_id: "s1", scenario_index: 0, scenario_name: "N", goal: "G", flow_run_uuid: "fr1",
    });
    await emitTurnCompleted(redis, u, {
      scenario_id: "s1", turn: 1, node_uuid: "n1", user: "hi", agent: "hello", intent: "greet",
      variables: {}, variables_by_node: {}, tool_calls: [], response_items: [],
      is_interruption: false, is_non_answer: false, non_answer_type: "", partial_assistant_msg: "",
    });
    await emitScenarioCompleted(redis, u, {
      scenario_id: "s1", flow_run_uuid: "fr1", stop_reason: "completed", turns: 1, nodes_visited: 1,
    });
    await emitSimulationCompleted(redis, u, { scenarios_processed: 1 });
    await emitSimulationError(redis, u, SIM_ERROR.UPSTREAM_TRANSIENT, "boom", "s1");

    const entries = await readEntries(redis, u);
    expect(entries.map((e) => e.type)).toEqual([
      "scenario_started", "turn_completed", "scenario_completed", "simulation_completed", "simulation_error",
    ]);
    for (const e of entries) {
      expect(e.data.simulation_run_uuid).toBe(u);
      expect(e.data.event_version).toBe(1);
    }
    expect(entries[0]!.data.event_data).toEqual({
      scenario_id: "s1", scenario_index: 0, scenario_name: "N", goal: "G", flow_run_uuid: "fr1",
    });
    expect(entries[1]!.data.event_data.intent).toBe("greet");
    // V1: scenario_completed carries NO evaluation / eval_error (eval deferred to V2)
    expect(entries[2]!.data.event_data).not.toHaveProperty("evaluation");
    expect(entries[2]!.data.event_data).not.toHaveProperty("eval_error");
    expect(entries[3]!.data.event_data).toEqual({ scenarios_processed: 1 });
    expect(entries[4]!.data.event_data).toEqual({ error_type: "UpstreamTransient", message: "boom", scenario_id: "s1" });

    await redis.del(resultsKey(u));
  });
});
