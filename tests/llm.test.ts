import { describe, test, expect, mock } from "bun:test";
import { z } from "zod";

// Mock config so importing the llm module doesn't parse real env (which would
// require DATABASE_URL and process.exit). Tests inject MockLLM directly, so the
// real provider SDKs are never loaded.
mock.module("../src/config.js", () => ({
  config: {
    LLM_PROVIDER: "anthropic",
    JUDGE_MODEL: undefined,
    SIMULATOR_MODEL: undefined,
    GENERATOR_MODEL: undefined,
    LLM_TIMEOUT_MS: 30000,
    LLM_MAX_RETRIES: 1,
  },
}));

const { completeJSON, MockLLM, LlmError } = await import("../src/llm/index.js");
import type { LlmProvider } from "../src/llm/types.js";

const Verdict = z.object({
  verdict: z.enum(["pass", "fail", "maybe"]),
  reasoning: z.string(),
});

describe("completeJSON", () => {
  test("parses and validates a valid JSON response (one attempt)", async () => {
    const llm = new MockLLM([JSON.stringify({ verdict: "pass", reasoning: "looks good" })]);
    const res = await completeJSON({ schema: Verdict, prompt: "judge this", provider: llm });
    expect(res.data).toEqual({ verdict: "pass", reasoning: "looks good" });
    expect(res.attempts).toBe(1);
    expect(res.usage.totalTokens).toBe(15);
  });

  test("strips markdown code fences before parsing", async () => {
    const llm = new MockLLM(['```json\n{"verdict":"fail","reasoning":"nope"}\n```']);
    const res = await completeJSON({ schema: Verdict, prompt: "x", provider: llm });
    expect(res.data.verdict).toBe("fail");
  });

  test("retries on invalid JSON, then succeeds (usage accumulates)", async () => {
    const llm = new MockLLM(["not json at all", JSON.stringify({ verdict: "maybe", reasoning: "unsure" })]);
    const res = await completeJSON({ schema: Verdict, prompt: "x", provider: llm });
    expect(res.attempts).toBe(2);
    expect(res.data.verdict).toBe("maybe");
    expect(res.usage.totalTokens).toBe(30); // two calls × 15
    // The retry prompt carries the parse error feedback.
    expect(llm.calls[1].user).toContain("not valid JSON");
  });

  test("retries on schema mismatch, then succeeds", async () => {
    const llm = new MockLLM([
      JSON.stringify({ verdict: "definitely" }), // invalid enum + missing reasoning
      JSON.stringify({ verdict: "pass", reasoning: "ok" }),
    ]);
    const res = await completeJSON({ schema: Verdict, prompt: "x", provider: llm });
    expect(res.attempts).toBe(2);
    expect(res.data.verdict).toBe("pass");
    expect(llm.calls[1].user).toContain("failed schema validation");
  });

  test("throws LlmError after exhausting retries", async () => {
    const llm = new MockLLM(["bad", "still bad"]);
    await expect(completeJSON({ schema: Verdict, prompt: "x", provider: llm })).rejects.toBeInstanceOf(LlmError);
  });

  test("uses explicit model when provided", async () => {
    const llm = new MockLLM([JSON.stringify({ verdict: "pass", reasoning: "ok" })]);
    await completeJSON({ schema: Verdict, prompt: "x", provider: llm, model: "claude-haiku-4-5" });
    expect(llm.calls[0].model).toBe("claude-haiku-4-5");
  });

  test("falls back to the default model when none is configured", async () => {
    const llm = new MockLLM([JSON.stringify({ verdict: "pass", reasoning: "ok" })]);
    await completeJSON({ schema: Verdict, prompt: "x", provider: llm, role: "judge" });
    expect(llm.calls[0].model).toBe("claude-opus-4-8");
  });

  test("aborts and fails when the provider exceeds the timeout", async () => {
    const slow: LlmProvider = {
      name: "slow",
      complete: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    await expect(
      completeJSON({ schema: Verdict, prompt: "x", provider: slow, timeoutMs: 50, maxRetries: 0 }),
    ).rejects.toBeInstanceOf(LlmError);
  });
});
