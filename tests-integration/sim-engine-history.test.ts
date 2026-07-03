import { describe, test, expect, afterAll } from "bun:test";
import { Redis } from "ioredis";
import {
  writeUserTurn,
  patchAssistantResponse,
  writeAssistantTurn,
  setSessionTTL,
} from "../src/sim-engine/run-engine/history.js";

// Stage 3: the Pipecat sm:{sessionID} conversation history. Needs a reachable Redis:
//   REDIS_URL=redis://127.0.0.1:6379 bun test tests-integration/sim-engine-history.test.ts

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
if (!client) console.warn(`[sim-engine-history] no Redis at ${REDIS_URL} — skipping integration suite`);

afterAll(async () => {
  if (client) await client.quit();
});

suite("sm:{} Pipecat history (integration)", () => {
  const redis = client!;

  test("writeUserTurn → patchAssistantResponse builds a paired turn at index 0", async () => {
    const sid = crypto.randomUUID();
    const idx = await writeUserTurn(redis, sid, "n1", "I need a refund");
    expect(idx).toBe(0);

    await patchAssistantResponse(redis, sid, idx, "n1", "refund_intent", { order_id: "A1" }, "Sure, let me help");

    const turn = JSON.parse((await redis.lindex(`sm:${sid}`, 0))!);
    expect(turn.user.content).toBe("I need a refund");
    expect(turn.user.role).toBe("user");
    expect(turn.user.meta_data.node_uuid).toBe("n1");
    expect(turn.assistant.content).toEqual({ intent: "refund_intent", variables: { order_id: "A1" }, message: "Sure, let me help" });
    expect(turn.assistant.role).toBe("assistant");

    await redis.del(`sm:${sid}`);
  });

  test("writeAssistantTurn appends an assistant-only turn (node switch)", async () => {
    const sid = crypto.randomUUID();
    await writeUserTurn(redis, sid, "n1", "hi");
    await writeAssistantTurn(redis, sid, "n2", "switch", {}, "Transferring you");

    expect(await redis.llen(`sm:${sid}`)).toBe(2);
    const second = JSON.parse((await redis.lindex(`sm:${sid}`, 1))!);
    expect(second.assistant.content.message).toBe("Transferring you");
    expect(second.user).toBeUndefined();

    await redis.del(`sm:${sid}`);
  });

  test("patchAssistantResponse throws on a missing index", async () => {
    const sid = crypto.randomUUID();
    await expect(patchAssistantResponse(redis, sid, 5, "n1", "x", {}, "y")).rejects.toThrow(/turn not found/);
  });

  test("setSessionTTL sets an expiry on the list", async () => {
    const sid = crypto.randomUUID();
    await writeUserTurn(redis, sid, "n1", "hi");
    await setSessionTTL(redis, sid, 60);
    expect(await redis.ttl(`sm:${sid}`)).toBeGreaterThan(0);
    await redis.del(`sm:${sid}`);
  });
});
