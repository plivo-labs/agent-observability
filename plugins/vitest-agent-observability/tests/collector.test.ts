import { describe, test, expect, beforeEach } from "vitest";
import {
  captureRunResult,
  recordJudgment,
  flushTaskMeta,
  peekPending,
  reset,
  newRun,
  randomUuid,
} from "../src/collector.js";

beforeEach(() => reset());

describe("captureRunResult", () => {
  test("stores into pending bucket", () => {
    const r = {};
    expect(captureRunResult(r)).toBe(r);
    expect(peekPending().runResults).toHaveLength(1);
  });
});

describe("recordJudgment", () => {
  test("appends to pending.judgments", () => {
    recordJudgment({ intent: "i", verdict: "pass", reasoning: "" });
    expect(peekPending().judgments).toEqual([
      { intent: "i", verdict: "pass", reasoning: "" },
    ]);
  });
});

describe("flushTaskMeta", () => {
  test("serializes captures onto task.meta.agentObs", () => {
    const runResult = {
      _user_input: "hello",
      events: [{ type: "message", item: { role: "assistant", text_content: "hi" } }],
    };
    captureRunResult(runResult);
    recordJudgment({ intent: "greets", verdict: "pass", reasoning: "ok" });

    const task: any = {};
    flushTaskMeta({ task });

    expect(task.meta.agentObs.events).toHaveLength(1);
    expect(task.meta.agentObs.events[0]).toMatchObject({
      type: "message",
      role: "assistant",
      content: "hi",
      interrupted: false,
    });
    expect(task.meta.agentObs.user_input).toBe("hello");
    expect(task.meta.agentObs.judgments[0].verdict).toBe("pass");
  });

  test("drains pending after flush", () => {
    captureRunResult({});
    const task: any = {};
    flushTaskMeta({ task });
    expect(peekPending().runResults).toHaveLength(0);
  });

  test("handles missing ctx gracefully", () => {
    captureRunResult({});
    flushTaskMeta(null);
    // Should still drain to prevent bleed-over between tests.
    expect(peekPending().runResults).toHaveLength(0);
  });
});

describe("newRun / randomUuid", () => {
  test("run has id + timestamps", () => {
    const run = newRun(100, { provider: "github" });
    expect(run.run_id).toMatch(/[0-9a-f-]{10,}/);
    expect(run.started_at).toBe(100);
    expect(run.cases).toEqual([]);
  });

  test("randomUuid returns a string", () => {
    const id = randomUuid();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(10);
  });
});
