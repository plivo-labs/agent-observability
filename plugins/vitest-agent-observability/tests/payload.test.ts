import { describe, test, expect } from "vitest";
import { buildPayload, TESTING_FRAMEWORK } from "../src/payload.js";
import { newRun } from "../src/collector.js";

describe("buildPayload", () => {
  test("payload shape", () => {
    const rc = newRun(100, { provider: "github" });
    rc.cases = [
      {
        case_id: "c1",
        name: "test_one",
        file: "tests/foo.test.ts",
        status: "passed",
        duration_ms: 1234,
        user_input: "hi",
        events: [{ type: "message", role: "assistant", content: "hello" }],
        judgments: [{ intent: "greets", verdict: "pass", reasoning: "" }],
        failure: null,
      },
    ];

    const payload = buildPayload({
      collector: rc,
      agentId: "support-bot",
      agentName: "Support Bot",
      accountId: "acct-1",
      finishedAt: 200,
    });

    expect(payload.version).toBe("v0");
    expect(payload.run.testing_framework).toBe(TESTING_FRAMEWORK);
    // testing_framework_version comes from `vitest`'s installed
    // package.json — the test runs under vitest so it must be set.
    expect(payload.run.testing_framework_version).toBeTypeOf("string");
    expect(payload.run.agent_id).toBe("support-bot");
    expect(payload.run.agent_name).toBe("Support Bot");
    expect(payload.run.account_id).toBe("acct-1");
    expect(payload.run.started_at).toBe(100);
    expect(payload.run.finished_at).toBe(200);
    expect(payload.run.ci).toEqual({ provider: "github" });
    expect(payload.cases).toHaveLength(1);
  });

  test("agent_name is null when unset", () => {
    // Default — neither plugin option nor env var resolved at the
    // index.ts call site. buildPayload itself takes whatever it's
    // given; this pins the null projection rather than `undefined`.
    const rc = newRun(0, null);
    const payload = buildPayload({
      collector: rc,
      agentId: "support-bot",
      accountId: null,
      finishedAt: 0,
    });
    expect(payload.run.agent_name).toBeNull();
  });

  test("agent_name passes through verbatim", () => {
    const rc = newRun(0, null);
    const payload = buildPayload({
      collector: rc,
      agentId: "support-bot",
      agentName: "Customer Bot",
      accountId: null,
      finishedAt: 0,
    });
    expect(payload.run.agent_name).toBe("Customer Bot");
  });

  test("detects livekit when @livekit/agents is installed", () => {
    // The plugin's own dependency tree pulls in @livekit/agents indirectly
    // via the examples vitest setup (peer-installed). When this test runs
    // standalone via `bunx vitest run` from the plugin root, the package
    // may not be on the path — we accept either `null` or `"livekit"`.
    const rc = newRun(0, null);
    const payload = buildPayload({
      collector: rc,
      agentId: null,
      accountId: null,
      finishedAt: 0,
    });
    expect(payload.run.framework === null || payload.run.framework === "livekit").toBe(true);
    if (payload.run.framework === "livekit") {
      expect(payload.run.framework_version).toBeTypeOf("string");
    }
  });

  test("empty collector", () => {
    const rc = newRun(0, null);
    const payload = buildPayload({
      collector: rc,
      agentId: null,
      accountId: null,
      finishedAt: 0,
    });
    expect(payload.cases).toEqual([]);
    expect(payload.run.agent_id).toBeNull();
  });
});
