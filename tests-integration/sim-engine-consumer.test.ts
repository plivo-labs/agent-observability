// Stage 7: the SQS consumer (dispatch adapter) end-to-end, against ElasticMQ + real Redis +
// a fake /turn server. Publishes N run_simulation_scenario messages, drains the queue with
// consumeSimulationQueue, and asserts the full per-scenario :RESULTS sequence, that the Lua
// completion gate fires simulation_completed EXACTLY once at N, that the processed count is N,
// and that the queue drains to empty.
//
//   REDIS_URL=redis://127.0.0.1:6379 bun test tests-integration/sim-engine-consumer.test.ts
//
// Skips cleanly when Redis OR ElasticMQ is unreachable. Starts (and stops, in afterAll) its own
// ElasticMQ container; Redis is expected to already be running on 6379.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Redis } from "ioredis";
import { execFileSync } from "node:child_process";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { LiveKitSimClient } from "../src/sim-engine/run-engine/livekit-client.js";
import { expectedCountKey, flowJsonKey, resultsKey } from "../src/sim-engine/queue/redis.js";
// Type-only import — erased at compile time, so it does NOT load the module before the env is
// set below. The runtime value (consumeSimulationQueue) comes from the dynamic import.
import type { ConsumerDeps } from "../src/sim-engine/queue/consumer.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const SQS_ENDPOINT = "http://127.0.0.1:9324";
const ELASTICMQ_CONTAINER = "ao-sim-elasticmq";
const SCENARIO_COUNT = 3;

// ── The SQS client reads its endpoint + creds from the AWS SDK chain at construction, so set
//    them BEFORE importing the consumer (a dynamic import below). ElasticMQ accepts any creds. ──
process.env.AWS_ENDPOINT_URL_SQS = SQS_ENDPOINT;
process.env.AWS_REGION = "us-east-1";
process.env.AWS_ACCESS_KEY_ID = "test";
process.env.AWS_SECRET_ACCESS_KEY = "test";

// Dynamic import AFTER the env is set (the module reads simEngineConfig.awsRegion on load).
const { consumeSimulationQueue } = await import("../src/sim-engine/queue/consumer.js");

// start → A1 (ai) → end. Turn 1's user message is the hardcoded "Hello!" (no LLM), A1 returns the
// `done` intent, the edge routes to end_conversation → the scenario stops with end_conversation.
const FLOW = JSON.stringify({
  nodes: [
    { id: "S", type: "start", data: { config: { name: "Start" } } },
    { id: "A1", type: "ai_agent_v2", data: { config: { name: "Agent1", intents: [{ id: "int-done", intent_name: "done" }] } } },
    { id: "E", type: "end_conversation", data: { config: { name: "End", end_message: "Bye" } } },
  ],
  edges: [
    { id: "S-A1", source: "S", target: "A1", sourceHandle: "http" },
    { id: "A1-E", source: "A1", target: "E", sourceHandle: "int-done" },
  ],
});

/** Build one scenario dict (the inline `payload.body.scenario`); distinct id per index. */
function makeScenario(index: number): Record<string, unknown> {
  return {
    id: `s${index}`,
    name: `Scenario ${index}`,
    persona: { personality: "calm", emotional_state: "neutral", behavioral_traits: [], details: {} },
    goal: `Goal ${index}`,
    language: "en-US",
    interruption: { enabled: false, probability: 0 },
    stt_noise: { enabled: false, severity: "light" },
    non_answer: { enabled: false, probability: 0 },
    world_state: {},
    start_node_params: {},
    max_turns: 25,
    tags: [],
  };
}

/** The aiassist→AO SQS envelope for one scenario. `extra` merges additional body fields
 *  (agent_id / scenario_uuid / run_name / … — the persistence-path additions). */
function makeEnvelope(runUuid: string, index: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_type: "simulation_eval",
    event_name: "run_simulation_scenario",
    visibility_timeout: 300,
    payload: {
      body: {
        simulation_run_uuid: runUuid,
        scenario_id: `s${index}`,
        auth_id: "acct-1",
        scenario_index: index,
        scenario: makeScenario(index),
        agent_flow_description: "Test agent",
        simulation_mode: "stress",
        enqueue_ts: Date.now(),
        ...extra,
      },
    },
  });
}

async function probeRedis(): Promise<Redis | null> {
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

/** Start ElasticMQ (idempotent) and wait until its SQS port answers a ListQueues-ish call. */
async function startElasticMq(): Promise<SQSClient | null> {
  // execFileSync (no shell) — args are a fixed array, so no shell metachar interpretation.
  try {
    execFileSync("docker", ["rm", "-f", ELASTICMQ_CONTAINER], { stdio: "ignore" });
  } catch {
    /* nothing to remove */
  }
  try {
    execFileSync(
      "docker",
      ["run", "-d", "--rm", "-p", "9324:9324", "--name", ELASTICMQ_CONTAINER, "softwaremill/elasticmq-native"],
      { stdio: "ignore" },
    );
  } catch (err) {
    console.warn(`[sim-engine-consumer] could not start ElasticMQ (${(err as Error).message}) — skipping`);
    return null;
  }

  const sqs = new SQSClient({ endpoint: SQS_ENDPOINT, region: "us-east-1" });
  // Poll for readiness: CreateQueue is idempotent, so we use it as the liveness probe.
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await sqs.send(new CreateQueueCommand({ QueueName: "readiness-probe" }));
      return sqs;
    } catch {
      await Bun.sleep(250);
    }
  }
  console.warn("[sim-engine-consumer] ElasticMQ did not become ready — skipping");
  return null;
}

const redis = await probeRedis();
const sqs = redis ? await startElasticMq() : null;
const ready = !!redis && !!sqs;
const suite = ready ? describe : describe.skip;
if (!redis) console.warn(`[sim-engine-consumer] no Redis at ${REDIS_URL} — skipping integration suite`);

let server: ReturnType<typeof Bun.serve>;
let turnBase = "";
let queueUrl = "";

beforeAll(async () => {
  // Fake /turn: A1 returns the `done` intent so the flow walks straight to end_conversation.
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      const node = body.node_uuid as string;
      return Response.json({
        message: `reply from ${node}`,
        intent: node === "A1" ? "done" : "",
        variables: {},
        tool_calls: [],
        response_items: [{ role: "assistant", content: `reply from ${node}` }],
        node_uuid: node,
        node_run_uuid: body.node_run_uuid,
        ended: true,
        stop_reason: "",
        context_items: [],
        variables_by_node: {},
      });
    },
  });
  turnBase = `http://127.0.0.1:${server.port}`;

  if (sqs) {
    const created = await sqs.send(new CreateQueueCommand({ QueueName: "sim-eval-test" }));
    queueUrl = created.QueueUrl!;
  }
});

afterAll(async () => {
  server?.stop(true);
  if (redis) await redis.quit();
  try {
    execFileSync("docker", ["rm", "-f", ELASTICMQ_CONTAINER], { stdio: "ignore" });
  } catch {
    /* container already gone */
  }
});

async function readEntries(r: Redis, u: string): Promise<{ type: string; data: any }[]> {
  const entries = (await r.call("XRANGE", resultsKey(u), "-", "+")) as [string, string[]][];
  return entries.map(([, fields]) => {
    const map: Record<string, string> = {};
    for (let i = 0; i + 1 < fields.length; i += 2) map[fields[i]!] = fields[i + 1]!;
    return { type: map.type!, data: JSON.parse(map.data!) };
  });
}

/** Approximate-messages-available, the ElasticMQ-visible queue depth (for the drain assertion). */
async function approxMessages(client: SQSClient, url: string): Promise<number> {
  const attrs = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["ApproximateNumberOfMessages"] }),
  );
  return Number(attrs.Attributes?.ApproximateNumberOfMessages ?? "0");
}

suite("consumeSimulationQueue — drains the queue + runs the turn loop E2E", () => {
  const r = redis!;
  const client = sqs!;

  test(`processes ${SCENARIO_COUNT} scenarios, fires simulation_completed exactly once, drains the queue`, async () => {
    const runUuid = crypto.randomUUID();

    // Seed FLOW_JSON + the expected scenario count for the run-level Lua gate.
    await r.set(flowJsonKey(runUuid), FLOW);
    await r.set(expectedCountKey(runUuid), String(SCENARIO_COUNT));

    // Publish N distinct scenario messages.
    for (let i = 0; i < SCENARIO_COUNT; i++) {
      await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: makeEnvelope(runUuid, i) }));
    }

    // Drain with the real consumer, pointing it at ElasticMQ + the fake /turn server.
    const abort = new AbortController();
    const deps: ConsumerDeps = { redis: r, runnerDeps: { livekit: new LiveKitSimClient({ url: turnBase }) } };
    const consumer = consumeSimulationQueue(deps, {
      queueUrl,
      concurrency: 4,
      signal: abort.signal,
      sqs: client,
    });

    // Wait until the :RESULTS stream shows N scenario_completed + the simulation_completed, then abort.
    const deadline = Date.now() + 30_000;
    let entries: { type: string; data: any }[] = [];
    while (Date.now() < deadline) {
      entries = await readEntries(r, runUuid);
      const completed = entries.filter((e) => e.type === "scenario_completed").length;
      const simDone = entries.some((e) => e.type === "simulation_completed");
      if (completed >= SCENARIO_COUNT && simDone) break;
      await Bun.sleep(100);
    }
    abort.abort();
    await consumer; // the long poll cancels on abort → the loop exits cleanly

    // ── Per-scenario sequence: each of s0..s2 emitted scenario_started + ≥1 turn_completed +
    //    scenario_completed. We group the events by scenario_id from their event_data. ──
    const byScenario = new Map<string, string[]>();
    for (const e of entries) {
      const sid = e.data.event_data?.scenario_id as string | undefined;
      if (sid === undefined) continue; // simulation_completed has no scenario_id
      const list = byScenario.get(sid) ?? [];
      list.push(e.type);
      byScenario.set(sid, list);
    }

    for (let i = 0; i < SCENARIO_COUNT; i++) {
      const types = byScenario.get(`s${i}`) ?? [];
      expect(types[0], `scenario s${i} should start with scenario_started`).toBe("scenario_started");
      expect(types.filter((t) => t === "turn_completed").length, `scenario s${i} should have ≥1 turn_completed`).toBeGreaterThanOrEqual(1);
      expect(types[types.length - 1], `scenario s${i} should end with scenario_completed`).toBe("scenario_completed");
      // The fake /turn drives A1→done→end, so every scenario ends on end_conversation (no error).
      const completedEvent = entries.find(
        (e) => e.type === "scenario_completed" && e.data.event_data.scenario_id === `s${i}`,
      );
      expect(completedEvent!.data.event_data.stop_reason).toBe("end_conversation");
    }

    // ── simulation_completed fires EXACTLY once (the Lua SETNX gate at N) with processed=N. ──
    const simCompletedEvents = entries.filter((e) => e.type === "simulation_completed");
    expect(simCompletedEvents.length).toBe(1);
    expect(simCompletedEvents[0]!.data.event_data.scenarios_processed).toBe(SCENARIO_COUNT);

    // ── The queue drains: no messages left visible. ──
    // ElasticMQ's ApproximateNumberOfMessages settles to 0 once all are deleted; allow a moment.
    let remaining = await approxMessages(client, queueUrl);
    for (let attempt = 0; attempt < 20 && remaining !== 0; attempt++) {
      await Bun.sleep(150);
      remaining = await approxMessages(client, queueUrl);
    }
    expect(remaining).toBe(0);

    // Cleanup the run-scoped keys.
    await r.del(
      resultsKey(runUuid),
      flowJsonKey(runUuid),
      expectedCountKey(runUuid),
      `SIM_EVAL:{${runUuid}}:SCENARIO_PROCESSED_COUNT`,
      `SIM_EVAL:{${runUuid}}:SCENARIO_COMPLETED`,
    );
  }, 45_000);

  // Durable persistence path (aodb-write.md): messages carrying agent_id (+ scenario_uuid /
  // run_name / scenario_count) make the consumer mirror every Redis emit with an ao_sim_* row.
  // Requires a reachable DATABASE_URL with migrations applied — probed + skipped inline so the
  // suite still runs Redis-only environments.
  test("persists ao_sim_run + ao_sim_run_scenario rows and emits scenario_db_ready when agent_id rides the message", async () => {
    const { sql } = await import("../src/db.js");
    try {
      await sql`SELECT 1 FROM ao_sim_run LIMIT 0`;
    } catch {
      console.warn("[sim-engine-consumer] DB unreachable or tables missing — skipping persistence test");
      return;
    }

    const runUuid = crypto.randomUUID();
    const AGENT = "it-consumer-phlo-uuid";
    const scenarioUuids = Array.from({ length: SCENARIO_COUNT }, () => crypto.randomUUID());
    // Own queue: the previous test's aborted 20s long-polls stay pending server-side in
    // ElasticMQ and would swallow messages sent to the shared queue into a 300s visibility
    // window (same reason the concurrency test below uses its own queue).
    const created = await client.send(new CreateQueueCommand({ QueueName: "sim-eval-persist" }));
    const persistQueueUrl = created.QueueUrl!;
    await r.set(flowJsonKey(runUuid), FLOW);
    await r.set(expectedCountKey(runUuid), String(SCENARIO_COUNT));
    for (let i = 0; i < SCENARIO_COUNT; i++) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: persistQueueUrl,
          MessageBody: makeEnvelope(runUuid, i, {
            agent_id: AGENT,
            scenario_uuid: scenarioUuids[i],
            run_name: "IT persistence run (AO)",
            scenario_count: SCENARIO_COUNT,
            max_turns: 25,
          }),
        }),
      );
    }

    const abort = new AbortController();
    const deps: ConsumerDeps = { redis: r, runnerDeps: { livekit: new LiveKitSimClient({ url: turnBase }) } };
    const consumer = consumeSimulationQueue(deps, { queueUrl: persistQueueUrl, concurrency: 4, signal: abort.signal, sqs: client });
    const deadline = Date.now() + 30_000;
    let entries: { type: string; data: any }[] = [];
    while (Date.now() < deadline) {
      entries = await readEntries(r, runUuid);
      if (entries.some((e) => e.type === "simulation_completed")) break;
      await Bun.sleep(100);
    }
    abort.abort();
    await consumer;

    // scenario_db_ready emitted once per scenario, echoing the flow_run_uuid as scenario_db_uuid.
    const dbReady = entries.filter((e) => e.type === "scenario_db_ready");
    expect(dbReady.length).toBe(SCENARIO_COUNT);
    const startedByScenario = new Map<string, string>(
      entries
        .filter((e) => e.type === "scenario_started")
        .map((e) => [e.data.event_data.scenario_id as string, e.data.event_data.flow_run_uuid as string]),
    );
    for (const e of dbReady) {
      expect(e.data.event_data.scenario_db_uuid).toBe(startedByScenario.get(e.data.event_data.scenario_id));
    }

    // Run header: name/count from the message, finalized at the gate, counters bumped per completion.
    const [run] = await sql`SELECT * FROM ao_sim_run WHERE id = ${runUuid}`;
    expect(run).toBeDefined();
    expect((run as Record<string, unknown>).agent_id).toBe(AGENT);
    expect((run as Record<string, unknown>).tenant_id).toBe("acct-1");
    expect((run as Record<string, unknown>).name).toBe("IT persistence run (AO)");
    expect((run as Record<string, unknown>).scenario_count).toBe(SCENARIO_COUNT);
    expect((run as Record<string, unknown>).status).toBe("completed");
    expect((run as Record<string, unknown>).completed_count).toBe(SCENARIO_COUNT);

    // Scenario rows: id = flow_run_uuid, scenario_ref = the library uuid from the message,
    // terminal status + non-empty transcript.
    const rows = await sql`SELECT * FROM ao_sim_run_scenario WHERE sim_run_id = ${runUuid} ORDER BY scenario_index`;
    expect(rows.length).toBe(SCENARIO_COUNT);
    for (let i = 0; i < SCENARIO_COUNT; i++) {
      const row = rows[i] as Record<string, unknown>;
      expect(row.scenario_ref).toBe(scenarioUuids[i]);
      expect(row.status).toBe("completed");
      expect(row.id).toBe(startedByScenario.get(`s${i}`));
      expect((row.transcript as unknown[]).length).toBeGreaterThanOrEqual(1);
    }

    // Cleanup rows + run-scoped keys.
    await sql`DELETE FROM ao_sim_run_scenario WHERE sim_run_id = ${runUuid}`;
    await sql`DELETE FROM ao_sim_run WHERE id = ${runUuid}`;
    await r.del(
      resultsKey(runUuid),
      flowJsonKey(runUuid),
      expectedCountKey(runUuid),
      `SIM_EVAL:{${runUuid}}:SCENARIO_PROCESSED_COUNT`,
      `SIM_EVAL:{${runUuid}}:SCENARIO_COMPLETED`,
    );
  }, 45_000);

  // The fan-out property: a pool of N workers keeps N scenarios in flight at once. A serial
  // consumer (the old batch-blocking loop against a queue that hands out 1 msg/receive) would peak
  // at exactly 1 concurrent /turn request; the pool must peak at >1. We measure it directly with a
  // /turn that sleeps (to widen the overlap window) and tracks the max simultaneous requests.
  test("runs scenarios concurrently — a pool of N workers keeps >1 in flight", async () => {
    const runUuid = crypto.randomUUID();
    const N = 4;
    await r.set(flowJsonKey(runUuid), FLOW);
    await r.set(expectedCountKey(runUuid), String(N));

    let inFlight = 0;
    let maxInFlight = 0;
    const slowServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await Bun.sleep(300); // widen the window so concurrent scenarios overlap on /turn
          const node = body.node_uuid as string;
          return Response.json({
            message: `reply from ${node}`,
            intent: node === "A1" ? "done" : "",
            variables: {},
            tool_calls: [],
            response_items: [{ role: "assistant", content: `reply from ${node}` }],
            node_uuid: node,
            node_run_uuid: body.node_run_uuid,
            ended: true,
            stop_reason: "",
            context_items: [],
            variables_by_node: {},
          });
        } finally {
          inFlight--;
        }
      },
    });

    try {
      const created = await client.send(new CreateQueueCommand({ QueueName: "sim-eval-concurrency" }));
      const concUrl = created.QueueUrl!;
      for (let i = 0; i < N; i++) {
        await client.send(new SendMessageCommand({ QueueUrl: concUrl, MessageBody: makeEnvelope(runUuid, i) }));
      }

      const abort = new AbortController();
      const deps: ConsumerDeps = { redis: r, runnerDeps: { livekit: new LiveKitSimClient({ url: `http://127.0.0.1:${slowServer.port}` }) } };
      const consumer = consumeSimulationQueue(deps, { queueUrl: concUrl, concurrency: N, signal: abort.signal, sqs: client });

      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const entries = await readEntries(r, runUuid);
        if (entries.filter((e) => e.type === "scenario_completed").length >= N) break;
        await Bun.sleep(100);
      }
      abort.abort();
      await consumer;

      // Serial would peak at 1; the pool must overlap. (Typically reaches N=4, but >1 is the
      // decisive, non-flaky assertion that scenarios ran in parallel rather than one-at-a-time.)
      expect(maxInFlight).toBeGreaterThan(1);
      expect(maxInFlight).toBeLessThanOrEqual(N);

      await r.del(
        resultsKey(runUuid),
        flowJsonKey(runUuid),
        expectedCountKey(runUuid),
        `SIM_EVAL:{${runUuid}}:SCENARIO_PROCESSED_COUNT`,
        `SIM_EVAL:{${runUuid}}:SCENARIO_COMPLETED`,
      );
    } finally {
      slowServer.stop(true);
    }
  }, 45_000);

  // Graceful shutdown: with an empty queue the workers park in their long-poll receive; aborting
  // must cancel those in-flight receives so consumeSimulationQueue resolves promptly (no hang).
  test("aborting stops all workers promptly", async () => {
    const created = await client.send(new CreateQueueCommand({ QueueName: "sim-eval-shutdown" }));
    const emptyUrl = created.QueueUrl!;

    const abort = new AbortController();
    const deps: ConsumerDeps = { redis: r, runnerDeps: { livekit: new LiveKitSimClient({ url: turnBase }) } };
    const consumer = consumeSimulationQueue(deps, { queueUrl: emptyUrl, concurrency: 4, signal: abort.signal, sqs: client });

    await Bun.sleep(300); // let all 4 workers enter their long poll
    const t0 = Date.now();
    abort.abort();
    await consumer; // must resolve: every worker's in-flight receive cancels on abort
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 20_000);
});
