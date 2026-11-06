import { expect, test } from "bun:test";
import { z } from "zod";
import { withDeadline, currentDeadlineSignal, sweepDeadlineMs } from "../src/deadline.js";
import { runLlmJudge } from "../src/evals-engine/judges/run-llm-judge.js";
import { completeJSON, type LlmProvider } from "../src/llm/index.js";

test("caller abort releases a never-settling provider without retrying", async () => {
  const controller = new AbortController();
  let calls = 0;
  let providerSignal: AbortSignal | undefined;
  const provider: LlmProvider = {
    name: "test",
    complete: ({ signal }) => {
      calls++;
      providerSignal = signal;
      return new Promise(() => {});
    },
  };
  const result = completeJSON({
    schema: z.object({ ok: z.boolean() }), prompt: "judge", model: "test-model",
    provider, signal: controller.signal, timeoutMs: 10_000, maxRetries: 2,
  });
  controller.abort(new Error("session expired"));
  const outcome = await Promise.race([
    result.catch((e: Error) => e.message),
    Bun.sleep(100).then(() => "still waiting"),
  ]);
  expect(outcome).toContain("aborted by caller");
  expect(providerSignal?.aborted).toBe(true);
  expect(calls).toBe(1);
}, 500);

const judgeArgs = { system: "judge", input: "input", schema: z.object({ ok: z.boolean() }), maxTokens: 50 };
const reply = { text: '{"ok":true}', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };

test("aborted semaphore waiters neither consume nor leak a slot", async () => {
  const releases: Array<() => void> = [];
  const provider: LlmProvider = {
    name: "test",
    complete: () => new Promise((resolve) => releases.push(() => resolve(reply))),
  };
  const holders = Array.from({ length: 10 }, () => runLlmJudge({ ...judgeArgs, provider }));
  await Bun.sleep(0);
  expect(releases).toHaveLength(10);
  const controller = new AbortController();
  const cancelled = runLlmJudge({ ...judgeArgs, provider, signal: controller.signal }).catch(() => "cancelled");
  const survivor = runLlmJudge({ ...judgeArgs, provider });
  controller.abort(new Error("expired"));
  const outcome = await Promise.race([cancelled, Bun.sleep(50).then(() => "waiting")]);
  for (const release of releases.slice()) release();
  await Promise.all(holders);
  await Bun.sleep(0);
  for (const release of releases.slice(10)) release();
  await Promise.all([cancelled, survivor]);
  expect(outcome).toBe("cancelled");
  expect(releases).toHaveLength(11);

  releases.length = 0;
  const next = Array.from({ length: 11 }, () => runLlmJudge({ ...judgeArgs, provider }));
  await Bun.sleep(0);
  expect(releases).toHaveLength(10);
  for (const release of releases.slice()) release();
  await Bun.sleep(0);
  expect(releases).toHaveLength(11);
  releases[10]!();
  await Promise.all(next);
});

test("caller abort interrupts retry backoff without starting another attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  const provider: LlmProvider = {
    name: "test",
    complete: async () => {
      calls++;
      throw Object.assign(new Error("busy"), { status: 429, headers: { "retry-after": "1" } });
    },
  };
  const result = completeJSON({ ...judgeArgs, prompt: "judge", model: "test-model", provider, signal: controller.signal });
  await Bun.sleep(10);
  controller.abort(new Error("expired"));
  const outcome = await Promise.race([
    result.catch((e: Error) => e.message),
    Bun.sleep(100).then(() => "still waiting"),
  ]);
  expect(outcome).toContain("aborted by caller");
  expect(calls).toBe(1);
});

test("session cancellation is isolated from concurrent sessions", async () => {
  const provider: LlmProvider = { name: "test", complete: async () => { await Bun.sleep(30); return reply; } };
  const expired = withDeadline("expired", 10, () => runLlmJudge({ ...judgeArgs, provider })).catch(() => "expired");
  const healthy = withDeadline("healthy", 200, () => runLlmJudge({ ...judgeArgs, provider }));
  expect(await expired).toBe("expired");
  expect((await healthy).data.ok).toBe(true);
  expect(currentDeadlineSignal()).toBeUndefined();
});

test("an already aborted judge never calls the provider", async () => {
  let calls = 0;
  const provider: LlmProvider = { name: "test", complete: async () => { calls++; return reply; } };
  await expect(runLlmJudge({ ...judgeArgs, provider, signal: AbortSignal.abort(new Error("expired")) })).rejects.toThrow("expired");
  expect(calls).toBe(0);
});

test("a provider rejection after the deadline remains handled", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const provider: LlmProvider = { name: "test", complete: async () => { await Bun.sleep(30); throw new Error("late rejection"); } };
    await expect(withDeadline("late provider", 10, () => runLlmJudge({ ...judgeArgs, provider }))).rejects.toThrow("deadline");
    await Bun.sleep(50);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a sweep deadline never cuts short a full round of healthy sessions", () => {
  expect(sweepDeadlineMs(3_600_000, 20, 3, 900_000)).toBe(7_200_000);
  expect(sweepDeadlineMs(10_000_000, 20, 3, 900_000)).toBe(10_000_000);
  expect(sweepDeadlineMs(250, 2, 1, 80)).toBe(250);
});

