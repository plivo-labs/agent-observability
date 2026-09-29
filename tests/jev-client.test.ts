import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { HttpJevClient, createJevClientFromConfig } = await import("../src/jev/client.js");
const { JevError, JEV_OVERFLOW } = await import("../src/jev/types.js");
const { MockJev } = await import("../src/jev/mock.js");
type JevRequest = import("../src/jev/types.js").JevRequest;

const req = (over: Partial<JevRequest> = {}): JevRequest => ({
  key: "n0",
  state: { conversation_history: "User: hi\nAgent: hello" },
  questions: {
    "n0.node_loop": { type: "noul", instructions: "loop?", criteria: { true: "looped", false: "no loop" } },
    "n0.h1": { type: "noul", instructions: "h1?", criteria: { true: "yes", false: "no" } },
  },
  estTokens: 100,
  estTotalTokens: 140,
  ...over,
});

type Call = { url: string; init: RequestInit };
function fakeFetch(handlers: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const h = handlers.length > 1 ? handlers.shift()! : handlers[0]!;
    return h(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const ok = (answers: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  json(200, { model: "jev-1.13.0", usage: { input_tokens: 120, output_tokens: 2 }, answers, ...extra });
const noSleep = async () => {};

describe("HttpJevClient wire shape", () => {
  test("posts {model, state, questions} with Bearer auth and maps noul answers", async () => {
    const f = fakeFetch([() => ok({ "n0.node_loop": { type: "noul", noul: 0.91 }, "n0.h1": { type: "noul", noul: 0.03 } })]);
    const c = new HttpJevClient({ apiKey: "k", baseUrl: "https://jev.test/", model: "jev-1.13.0", fetchImpl: f.impl, sleep: noSleep });
    const res = await c.systemOne(req());
    expect(f.calls[0]!.url).toBe("https://jev.test/v1/systemone");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer k");
    const body = JSON.parse(f.calls[0]!.init.body as string);
    expect(body.model).toBe("jev-1.13.0");
    expect(body.state.conversation_history).toContain("User: hi");
    expect(body.questions["n0.node_loop"]).toEqual({ type: "noul", instructions: "loop?", criteria: { true: "looped", false: "no loop" } });
    expect(res.answers["n0.node_loop"]!.noul).toBe(0.91);
    expect(res.usage.input_tokens).toBe(120);
    expect(res.model).toBe("jev-1.13.0");
  });

  test("a missing, unrequested or malformed answer is dropped, never a probability", async () => {
    const f = fakeFetch([() => ok({ "n0.node_loop": { type: "noul", noul: 1.7 }, stray: { type: "noul", noul: 0.5 } })]);
    const c = new HttpJevClient({ apiKey: "k", fetchImpl: f.impl, sleep: noSleep });
    const res = await c.systemOne(req());
    expect(res.answers).toEqual({});
  });

  test("400 max_tokens_exceeded is thrown immediately and not retried", async () => {
    const f = fakeFetch([() => json(400, { detail: { error_type: JEV_OVERFLOW } })]);
    const c = new HttpJevClient({ apiKey: "k", fetchImpl: f.impl, sleep: noSleep });
    const err = await c.systemOne(req()).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect(err.status).toBe(400);
    expect(err.errorType).toBe(JEV_OVERFLOW);
    expect(err.message).toBe(`jev 400 ${JEV_OVERFLOW}`);
    expect(f.calls).toHaveLength(1);
  });

  test("429 retries honouring Retry-After, then succeeds", async () => {
    const waits: number[] = [];
    const f = fakeFetch([() => json(429, { detail: "slow down" }, { "retry-after": "2" }), () => ok({ "n0.node_loop": { type: "noul", noul: 0.1 } })]);
    const c = new HttpJevClient({ apiKey: "k", fetchImpl: f.impl, sleep: async (ms) => { waits.push(ms); } });
    const res = await c.systemOne(req());
    expect(res.answers["n0.node_loop"]!.noul).toBe(0.1);
    expect(waits).toEqual([2000]);
    expect(f.calls).toHaveLength(2);
  });

  test("529 is 'overloaded' and exhausts retries as a transient-looking error", async () => {
    const f = fakeFetch([() => new Response("busy", { status: 529 })]);
    const c = new HttpJevClient({ apiKey: "k", fetchImpl: f.impl, sleep: noSleep, maxRetries: 1 });
    const err = await c.systemOne(req()).catch((e) => e);
    expect(err.message).toBe("jev 529 overloaded");
    expect(f.calls).toHaveLength(2);
  });

  test("a timeout aborts the request and surfaces as jev 408 timeout", async () => {
    const f = fakeFetch([(call) => new Promise((_, reject) => { (call.init.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted"))); })]);
    const c = new HttpJevClient({ apiKey: "k", fetchImpl: f.impl, sleep: noSleep, timeoutMs: 20, maxRetries: 0 });
    const err = await c.systemOne(req()).catch((e) => e);
    expect(err.message).toContain("jev 408 timeout");
  });

  test("a stalled ERROR body times out instead of hanging, and frees its slot", async () => {
    // A body that never completes until the request is aborted — what a real
    // fetch does when the gateway sends headers and then stalls.
    const f = fakeFetch([(call) =>
      new Response(
        new ReadableStream({
          start(controller) {
            (call.init.signal as AbortSignal).addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      )]);
    const c = new HttpJevClient({ apiKey: "k", fetchImpl: f.impl, sleep: noSleep, timeoutMs: 25, maxRetries: 0, maxConcurrent: 1 });
    const err = await c.systemOne(req()).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect(err.errorType).toBe("timeout");
    // the slot came back: a second call is served rather than queued forever
    const ok2 = fakeFetch([() => ok({ "n0.node_loop": { type: "noul", noul: 0.1 } })]);
    const c2 = new HttpJevClient({ apiKey: "k", fetchImpl: ok2.impl, sleep: noSleep, maxConcurrent: 1 });
    await expect(c2.systemOne(req())).resolves.toBeDefined();
  });

  test("an invalid 200 body is jev <status> invalid_response", async () => {
    const f = fakeFetch([() => new Response("<html>", { status: 200 })]);
    const c = new HttpJevClient({ apiKey: "k", fetchImpl: f.impl, sleep: noSleep });
    const err = await c.systemOne(req()).catch((e) => e);
    expect(err.errorType).toBe("invalid_response");
  });

  test("concurrency cap queues requests instead of dropping them", async () => {
    let inFlight = 0, peak = 0;
    const f = fakeFetch([async () => { inFlight++; peak = Math.max(peak, inFlight); await Bun.sleep(5); inFlight--; return ok({}); }]);
    const c = new HttpJevClient({ apiKey: "k", fetchImpl: f.impl, sleep: noSleep, maxConcurrent: 2 });
    await Promise.all([1, 2, 3, 4, 5].map((i) => c.systemOne(req({ key: `n${i}` }))));
    expect(peak).toBe(2);
    expect(f.calls).toHaveLength(5);
  });
});

describe("createJevClientFromConfig", () => {
  test("is null while JEV_MODE=off (the test fixture default)", () => {
    expect(createJevClientFromConfig()).toBeNull();
  });

  test("returns ONE client for the whole process — the concurrency cap is across sessions", async () => {
    const { __resetJevClientForTest } = await import("../src/jev/client.js");
    const { config } = await import("../src/config.js");
    const mutable = config as Record<string, unknown>;
    const prior = { mode: mutable.JEV_MODE, key: mutable.JEV_API_KEY };
    __resetJevClientForTest();
    mutable.JEV_MODE = "primary";
    mutable.JEV_API_KEY = "k";
    try {
      const first = createJevClientFromConfig();
      expect(first).not.toBeNull();
      expect(createJevClientFromConfig()).toBe(first);
    } finally {
      mutable.JEV_MODE = prior.mode;
      mutable.JEV_API_KEY = prior.key;
      __resetJevClientForTest();
    }
  });
});

describe("MockJev", () => {
  test("fills requested keys from the map and defaults the rest", async () => {
    const m = new MockJev([{ "n0.node_loop": 0.9 }]);
    const res = await m.systemOne(req());
    expect(res.answers["n0.node_loop"]!.noul).toBe(0.9);
    expect(res.answers["n0.h1"]!.noul).toBe(0.02);
    expect(m.calls).toHaveLength(1);
  });
  test("null default leaves omitted keys unanswered; Error responders throw", async () => {
    const m = new MockJev([{ "n0.node_loop": 0.9 }, new JevError(500, "boom")], null);
    const res = await m.systemOne(req());
    expect(Object.keys(res.answers)).toEqual(["n0.node_loop"]);
    await expect(m.systemOne(req())).rejects.toThrow("jev 500 boom");
  });
});
