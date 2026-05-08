import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import AgentObservabilityReporter from "../src/index.js";

const silentLogger = { warn: () => {}, error: () => {} };

function makeFile(name: string, tasks: any[]): any {
  return {
    id: `file-${name}`,
    name,
    filepath: `/tmp/${name}`,
    type: "suite",
    tasks,
  };
}

function makeTest(
  name: string,
  result: { state: "pass" | "fail" | "skip"; duration?: number; errors?: any[] },
  meta?: any,
): any {
  return { id: `t-${name}`, name, type: "test", result, meta };
}

describe("AgentObservabilityReporter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  test("no-op when no URL configured", async () => {
    const reporter = new AgentObservabilityReporter({});
    (reporter as any).logger = silentLogger;
    await reporter.onInit({});
    await reporter.onFinished([makeFile("a.test.ts", [makeTest("t1", { state: "pass" })])], []);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("uploads on finish with url option", async () => {
    const reporter = new AgentObservabilityReporter({
      url: "http://stub:9090",
      agentId: "support-bot",
      runName: "prompt-v2",
      fallbackDir: null as any,
      liveStreaming: false,
    });
    (reporter as any).logger = silentLogger;
    await reporter.onInit({});

    const file = makeFile("a.test.ts", [
      makeTest("passes", { state: "pass", duration: 10 }),
      makeTest("fails", {
        state: "fail",
        duration: 5,
        errors: [{ name: "AssertionError", message: "expected 1 to equal 2" }],
      }),
      makeTest("skipped", { state: "skip" }),
    ]);
    await reporter.onFinished([file], []);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://stub:9090/observability/evals/v0");
    const body = JSON.parse(init.body as string);
    expect(body.version).toBe("v0");
    expect(body.run.testing_framework).toBe("vitest");
    expect(body.run.name).toBe("prompt-v2");
    expect(body.run.agent_id).toBe("support-bot");
    expect(body.cases).toHaveLength(3);

    const byName: Record<string, any> = Object.fromEntries(
      body.cases.map((c: any) => [c.name, c]),
    );
    expect(byName.passes.status).toBe("passed");
    expect(byName.fails.status).toBe("failed");
    expect(byName.fails.failure.kind).toBe("assertion");
    expect(byName.skipped.status).toBe("skipped");
  });

  test("reads task.meta.agentObs for events + judgments", async () => {
    const reporter = new AgentObservabilityReporter({
      url: "http://stub:9090",
      fallbackDir: null as any,
      liveStreaming: false,
    });
    (reporter as any).logger = silentLogger;
    await reporter.onInit({});

    const file = makeFile("a.test.ts", [
      makeTest(
        "with_capture",
        { state: "pass", duration: 12 },
        {
          agentObs: {
            events: [{ type: "message", role: "assistant", content: "hi" }],
            user_input: "hello",
            judgments: [{ intent: "greets", verdict: "pass", reasoning: "" }],
          },
        },
      ),
    ]);
    await reporter.onFinished([file], []);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const c = body.cases[0];
    expect(c.events).toEqual([{ type: "message", role: "assistant", content: "hi" }]);
    expect(c.user_input).toBe("hello");
    expect(c.judgments[0].verdict).toBe("pass");
  });

  test("judge_failed kind inferred from fail verdict", async () => {
    const reporter = new AgentObservabilityReporter({
      url: "http://stub:9090",
      fallbackDir: null as any,
      liveStreaming: false,
    });
    (reporter as any).logger = silentLogger;
    await reporter.onInit({});

    const file = makeFile("a.test.ts", [
      makeTest(
        "bad",
        {
          state: "fail",
          duration: 5,
          errors: [{ name: "AssertionError", message: "Judgement failed: hallucinated" }],
        },
        {
          agentObs: {
            events: [],
            judgments: [{ intent: "grounded", verdict: "fail", reasoning: "hallucinated" }],
          },
        },
      ),
    ]);
    await reporter.onFinished([file], []);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.cases[0].failure.kind).toBe("judge_failed");
  });

  test("prints run_id + dashboard URL on successful upload", async () => {
    const infos: string[] = [];
    const reporter = new AgentObservabilityReporter({
      url: "http://stub:9090",
      fallbackDir: null as any,
      liveStreaming: false,
    });
    (reporter as any).logger = {
      info: (m: string) => infos.push(m),
      warn: () => {},
      error: () => {},
    };
    await reporter.onInit({});
    await reporter.onFinished([makeFile("a.test.ts", [makeTest("t1", { state: "pass" })])], []);

    const runId = JSON.parse(fetchMock.mock.calls[0][1].body as string).run.run_id;
    expect(infos).toContain(`Run uploaded: ${runId}`);
    expect(infos).toContain(`View at:      http://stub:9090/evals/${runId}`);
  });

  test("prints fallback path on upload failure", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 500 }));
    const warns: string[] = [];
    const reporter = new AgentObservabilityReporter({
      url: "http://stub:9090",
      fallbackDir: "/tmp/vitest-ao-fallback",
      maxRetries: 1,
      liveStreaming: false,
    });
    (reporter as any).logger = {
      info: () => {},
      warn: (m: string) => warns.push(m),
      error: () => {},
    };
    await reporter.onInit({});
    await reporter.onFinished([makeFile("a.test.ts", [makeTest("t1", { state: "pass" })])], []);

    const runId = JSON.parse(fetchMock.mock.calls[0][1].body as string).run.run_id;
    expect(warns).toContain(`Run upload failed: ${runId}`);
    expect(warns).toContain(`Payload saved: /tmp/vitest-ao-fallback/${runId}.json`);
  });

  test("walks nested suites", async () => {
    const reporter = new AgentObservabilityReporter({
      url: "http://stub:9090",
      fallbackDir: null as any,
      liveStreaming: false,
    });
    (reporter as any).logger = silentLogger;
    await reporter.onInit({});

    const file = makeFile("a.test.ts", [
      {
        id: "s1",
        name: "Assistant",
        type: "suite",
        tasks: [
          makeTest("greets", { state: "pass" }),
          makeTest("refuses", { state: "pass" }),
        ],
      },
    ]);
    await reporter.onFinished([file], []);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.cases.map((c: any) => c.name).sort()).toEqual(["greets", "refuses"]);
  });

  // ── Live streaming tests ───────────────────────────────────────────────────

  test("start POST fires before any case completes", async () => {
    const reporter = new AgentObservabilityReporter({
      url: "http://stub:9090",
      fallbackDir: null as any,
      liveStreaming: true,
      flushIntervalMs: 60_000, // prevent flush during test
    });
    (reporter as any).logger = silentLogger;
    await reporter.onInit({});

    // stub POST should have fired immediately in onInit
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://stub:9090/observability/evals/v0");
    const body = JSON.parse(init.body as string);
    expect(body.run.status).toBe("running");
    expect(body.run.finished_at).toBeNull();
    expect(body.cases).toEqual([]);

    // clean up timer
    await reporter.onFinished([], []);
  });

  test("per-case stream contains only newly-finished cases (not cumulative)", async () => {
    vi.useFakeTimers();
    const reporter = new AgentObservabilityReporter({
      url: "http://stub:9090",
      fallbackDir: null as any,
      liveStreaming: true,
      flushIntervalMs: 100,
      heartbeatIntervalMs: 60_000,
    });
    (reporter as any).logger = silentLogger;
    await reporter.onInit({});

    // call[0] = start stub
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // simulate two tests completing
    const t1 = makeTest("t1", { state: "pass" });
    const t2 = makeTest("t2", { state: "fail", errors: [{ name: "Error", message: "bad" }] });
    reporter.onTaskUpdate([
      ["id1", t1.result, t1],
      ["id2", t2.result, t2],
    ]);

    // advance timer to trigger flush
    vi.advanceTimersByTime(150);
    await Promise.resolve();

    // call[1] = live flush with the 2 cases
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const liveBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(liveBody.run.status).toBe("running");
    expect(liveBody.run.finished_at).toBeNull();
    expect(liveBody.cases).toHaveLength(2);

    // advance again — no new cases, so no flush (heartbeat not due yet)
    vi.advanceTimersByTime(150);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await reporter.onFinished([], []);
    vi.useRealTimers();
  });

  test("heartbeat POST fires when idle past interval", async () => {
    vi.useFakeTimers();
    const reporter = new AgentObservabilityReporter({
      url: "http://stub:9090",
      fallbackDir: null as any,
      liveStreaming: true,
      flushIntervalMs: 100,
      heartbeatIntervalMs: 200,
    });
    (reporter as any).logger = silentLogger;
    await reporter.onInit({});
    // call[0] = start stub; lastFlushAt set to now

    // advance past heartbeat interval with no new cases
    vi.advanceTimersByTime(300);
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const hbBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(hbBody.cases).toEqual([]);
    expect(hbBody.run.finished_at).toBeNull();

    await reporter.onFinished([], []);
    vi.useRealTimers();
  });

  test("final POST has all cases and status=completed", async () => {
    const reporter = new AgentObservabilityReporter({
      url: "http://stub:9090",
      fallbackDir: null as any,
      liveStreaming: true,
      flushIntervalMs: 60_000,
    });
    (reporter as any).logger = silentLogger;
    await reporter.onInit({});

    const file = makeFile("a.test.ts", [
      makeTest("t1", { state: "pass" }),
      makeTest("t2", { state: "pass" }),
    ]);
    await reporter.onFinished([file], []);

    // call[0]=start stub, call[1]=final
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const finalBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(finalBody.run.status).toBe("completed");
    expect(finalBody.run.finished_at).toBeGreaterThan(0);
    expect(finalBody.cases).toHaveLength(2);
  });

  test("final POST has status=failed when errors present", async () => {
    const reporter = new AgentObservabilityReporter({
      url: "http://stub:9090",
      fallbackDir: null as any,
      liveStreaming: true,
      flushIntervalMs: 60_000,
    });
    (reporter as any).logger = silentLogger;
    await reporter.onInit({});
    await reporter.onFinished([], [new Error("suite error")]);

    const finalBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(finalBody.run.status).toBe("failed");
  });

  test("live POST error does not crash reporter", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 201 })) // start stub ok
      .mockRejectedValue(new TypeError("network error")); // all subsequent fail

    const reporter = new AgentObservabilityReporter({
      url: "http://stub:9090",
      fallbackDir: null as any,
      liveStreaming: true,
      flushIntervalMs: 100,
      heartbeatIntervalMs: 200,
    });
    (reporter as any).logger = silentLogger;

    // should not throw
    await expect(reporter.onInit({})).resolves.toBeUndefined();

    const t1 = makeTest("t1", { state: "pass" });
    reporter.onTaskUpdate([["id1", t1.result, t1]]);

    // flush tick will call bestEffortPost which catches the error — just must not throw
    vi.advanceTimersByTime(150);
    await Promise.resolve();

    // reporter still alive — onFinished should complete without throwing
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    await expect(reporter.onFinished([], [])).resolves.toBeUndefined();

    vi.useRealTimers();
  });
});
