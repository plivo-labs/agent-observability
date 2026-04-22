import { describe, test, expect } from "vitest";
import { buildPayload, FRAMEWORK, SDK } from "../src/payload.js";
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
      accountId: "acct-1",
      finishedAt: 200,
    });

    expect(payload.version).toBe("v0");
    expect(payload.run.framework).toBe(FRAMEWORK);
    expect(payload.run.sdk).toBe(SDK);
    expect(payload.run.agent_id).toBe("support-bot");
    expect(payload.run.account_id).toBe("acct-1");
    expect(payload.run.started_at).toBe(100);
    expect(payload.run.finished_at).toBe(200);
    expect(payload.run.ci).toEqual({ provider: "github" });
    expect(payload.cases).toHaveLength(1);
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
