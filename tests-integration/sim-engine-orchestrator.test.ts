import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Redis } from "ioredis";
import { runScenario, type RunScenarioJob } from "../src/sim-engine/run-engine/orchestrator.js";
import { LiveKitSimClient } from "../src/sim-engine/run-engine/livekit-client.js";
import { resultsKey } from "../src/sim-engine/queue/redis.js";
import type { Scenario } from "../src/sim-engine/schema.js";

// Stage 6: one scenario end-to-end through the turn-loop orchestrator, against a fake /turn server
// + real Redis. Asserts the :RESULTS sequence (scenario_started → turn_completed* → scenario_completed),
// the node-switch handling, state threading (context_items / variables_by_node), the sm:{} history,
// and the terminal OrchestratorResult. No LLM: turn 1 is the hardcoded "Hello!" and turn 2 is a node
// switch (user_message ""), so generateUserMessage is never reached (it's covered by the Stage 5 tests).
//   REDIS_URL=redis://127.0.0.1:6379 bun test tests-integration/sim-engine-orchestrator.test.ts

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

// start → A1 (ai) → A2 (ai) → end. Start edge uses the "http" trigger handle; intent edges use the
// intent id as the sourceHandle (resolveIntentSourceHandle maps the returned name/id onto it).
const FLOW = JSON.stringify({
  nodes: [
    { id: "S", type: "start", data: { config: { name: "Start" } } },
    { id: "A1", type: "ai_agent_v2", data: { config: { name: "Agent1", intents: [{ id: "int-1", intent_name: "to_a2" }] } } },
    { id: "A2", type: "ai_agent_v2", data: { config: { name: "Agent2", intents: [{ id: "int-2", intent_name: "done" }] } } },
    { id: "E", type: "end_conversation", data: { config: { name: "End", end_message: "Bye" } } },
  ],
  edges: [
    { id: "S-A1", source: "S", target: "A1", sourceHandle: "http" },
    { id: "A1-A2", source: "A1", target: "A2", sourceHandle: "int-1" },
    { id: "A2-E", source: "A2", target: "E", sourceHandle: "int-2" },
  ],
});

const SCENARIO = {
  id: "s1",
  name: "E2E refund",
  persona: { personality: "calm", emotional_state: "neutral", behavioral_traits: [], details: {} },
  goal: "Resolve a refund",
  language: "en-US",
  interruption: { enabled: false, probability: 0 },
  stt_noise: { enabled: false, severity: "light" },
  non_answer: { enabled: false, probability: 0 },
  world_state: {},
  start_node_params: {},
  max_turns: 25,
  tags: [],
} as unknown as Scenario;

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
if (!client) console.warn(`[sim-engine-orchestrator] no Redis at ${REDIS_URL} — skipping integration suite`);

// Fake /turn server: returns an intent per node so the flow walks A1 → A2 → end. Captures each
// request so the test can assert auth + state threading.
let server: ReturnType<typeof Bun.serve>;
let turnBase = "";
const requests: Record<string, unknown>[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      requests.push(body);
      const node = body.node_uuid as string;
      const intent = node === "A1" ? "to_a2" : node === "A2" ? "done" : "";
      return Response.json({
        message: `reply from ${node}`,
        intent,
        variables: { last_node: node },
        tool_calls: [],
        response_items: [{ role: "assistant", content: `reply from ${node}` }],
        node_uuid: node,
        node_run_uuid: body.node_run_uuid,
        ended: intent === "done",
        stop_reason: "",
        context_items: [{ n: node }],
        variables_by_node: { [node]: { seen: true } },
      });
    },
  });
  turnBase = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server?.stop(true);
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

suite("runScenario — full turn loop E2E", () => {
  const redis = client!;

  test("walks start→ai1→ai2→end, emitting the correct :RESULTS sequence + sm:{} history", async () => {
    const job: RunScenarioJob = {
      simRunUuid: crypto.randomUUID(),
      scenarioId: "s1",
      scenarioIndex: 0,
      scenario: SCENARIO,
      authId: "acct-1",
      agentFlowDescription: "Refund agent",
      flowJson: FLOW,
      maxTurns: 25,
    };

    const deps = { redis, livekit: new LiveKitSimClient({ url: turnBase }) };
    const result = await runScenario(deps, job);

    // terminal OrchestratorResult
    expect(result.stop_reason).toBe("end_conversation");
    expect(result.turn_count).toBe(2);
    expect(result.nodes_visited).toEqual(["S", "A1", "A2", "E"]);

    // :RESULTS sequence
    const entries = await readEntries(redis, job.simRunUuid);
    expect(entries.map((e) => e.type)).toEqual([
      "scenario_started", "turn_completed", "turn_completed", "scenario_completed",
    ]);

    const started = entries[0]!.data.event_data;
    expect(started.scenario_id).toBe("s1");
    expect(started.scenario_index).toBe(0);
    const flowRunUuid = started.flow_run_uuid as string;
    expect(flowRunUuid).toBeTruthy();

    // turn 1 at A1 — opening "Hello!", not a node switch
    const t1 = entries[1]!.data.event_data;
    expect(t1.turn).toBe(1);
    expect(t1.node_uuid).toBe("A1");
    expect(t1.user).toBe("Hello!");
    expect(t1.agent).toBe("reply from A1");
    expect(t1.intent).toBe("to_a2");
    expect(t1.is_interruption).toBe(false);
    expect(t1.is_non_answer).toBe(false);

    // turn 2 at A2 — node switch → empty user message
    const t2 = entries[2]!.data.event_data;
    expect(t2.turn).toBe(2);
    expect(t2.node_uuid).toBe("A2");
    expect(t2.user).toBe("");
    expect(t2.intent).toBe("done");

    // scenario_completed
    const done = entries[3]!.data.event_data;
    expect(done.stop_reason).toBe("end_conversation");
    expect(done.turns).toBe(2);
    expect(done.nodes_visited).toBe(4);
    expect(done.flow_run_uuid).toBe(flowRunUuid);

    // state threading: turn 2's /turn request carries turn 1's returned context + variables_by_node
    expect(requests).toHaveLength(2);
    expect(requests[0]!.auth_id).toBe("acct-1");
    expect(requests[1]!.context_items).toEqual([{ n: "A1" }]);
    expect(requests[1]!.variables_by_node).toEqual({ A1: { seen: true } });

    // sm:{} history: turn 1 is a paired user+assistant turn; turn 2 (node switch) is assistant-only
    expect(await redis.llen(`sm:${flowRunUuid}`)).toBe(2);
    const h0 = JSON.parse((await redis.lindex(`sm:${flowRunUuid}`, 0))!);
    expect(h0.user.content).toBe("Hello!");
    // user.content is the raw string; assistant.content is the structured {intent,variables,message}.
    expect(h0.assistant.content.message).toBe("reply from A1");
    expect(h0.assistant.content.intent).toBe("to_a2");
    const h1 = JSON.parse((await redis.lindex(`sm:${flowRunUuid}`, 1))!);
    expect(h1.assistant.content.message).toBe("reply from A2");
    expect(h1.assistant.content.intent).toBe("done");
    expect(h1.user).toBeUndefined();

    await redis.del(resultsKey(job.simRunUuid), `sm:${flowRunUuid}`);
  });
});
