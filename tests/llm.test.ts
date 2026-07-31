import { describe, test, expect, mock } from "bun:test";
import { z } from "zod";
import { TEST_CONFIG_MODULE_DEFAULTS } from "./fixtures/judge-config.js";

// Mock config so importing the llm module doesn't parse real env (which would
// require DATABASE_URL and process.exit). Tests inject MockLLM directly, so the
// real provider SDKs are never loaded.
mock.module("../src/config.js", () => ({
  ...TEST_CONFIG_MODULE_DEFAULTS,
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

// A capped call that truncates (`status="incomplete" reason="max_output_tokens"`) is
// deterministic: resending identical parameters fails identically, which is how whole
// sessions' evals were lost in prod (2026-07-14 ap-south; 2026-07-23 both regions —
// invisible reasoning tokens exhausted caps sized for visible output, and all 3
// attempts sent the same request). These tests pin the escalation contract.
describe("completeJSON — truncation escalation", () => {
  const TRUNCATION = 'responses status="incomplete" reason="max_output_tokens" (incomplete output)';
  const ok = JSON.stringify({ verdict: "pass", reasoning: "fits now" });

  test("doubles the cap and drops medium effort to low on a truncated attempt", async () => {
    const llm = new MockLLM([
      () => { throw new Error(TRUNCATION); },
      ok,
    ]);
    const res = await completeJSON({
      schema: Verdict, prompt: "x", provider: llm,
      maxTokens: 1500, reasoningEffort: "medium", maxRetries: 2,
    });
    expect(res.attempts).toBe(2);
    expect(llm.calls[0].maxTokens).toBe(1500);
    expect(llm.calls[0].reasoningEffort).toBe("medium");
    expect(llm.calls[1].maxTokens).toBe(3000);
    expect(llm.calls[1].reasoningEffort).toBe("low");
  });

  test("escalation is bounded to 4x the caller's cap; effort never drops below low", async () => {
    const llm = new MockLLM([
      () => { throw new Error(TRUNCATION); },
      () => { throw new Error(TRUNCATION); },
      () => { throw new Error(TRUNCATION); },
      ok,
    ]);
    const res = await completeJSON({
      schema: Verdict, prompt: "x", provider: llm,
      maxTokens: 1500, reasoningEffort: "high", maxRetries: 3,
    });
    expect(res.attempts).toBe(4);
    expect(llm.calls.map((c) => c.maxTokens)).toEqual([1500, 3000, 6000, 6000]); // 4x ceiling
    expect(llm.calls.map((c) => c.reasoningEffort)).toEqual(["high", "low", "low", "low"]);
  });

  test('"none" effort is never adaptively changed — some deployments reject other values', async () => {
    const llm = new MockLLM([
      () => { throw new Error(TRUNCATION); },
      ok,
    ]);
    await completeJSON({
      schema: Verdict, prompt: "x", provider: llm,
      maxTokens: 1500, reasoningEffort: "none", maxRetries: 1,
    });
    expect(llm.calls[1].maxTokens).toBe(3000); // cap still escalates
    expect(llm.calls[1].reasoningEffort).toBe("none");
  });

  test("transient provider errors do NOT escalate — request shape stays identical", async () => {
    const llm = new MockLLM([
      () => { throw new Error("429 too many requests"); },
      ok,
    ]);
    await completeJSON({
      schema: Verdict, prompt: "x", provider: llm,
      maxTokens: 1500, reasoningEffort: "medium", maxRetries: 1,
    });
    expect(llm.calls[1].maxTokens).toBe(1500);
    expect(llm.calls[1].reasoningEffort).toBe("medium");
  });

  test("uncapped calls (maxTokens null → 0) never enter the escalation path", async () => {
    const llm = new MockLLM([
      () => { throw new Error(TRUNCATION); },
      ok,
    ]);
    await completeJSON({ schema: Verdict, prompt: "x", provider: llm, maxTokens: null, maxRetries: 1 });
    expect(llm.calls[1].maxTokens).toBe(0);
  });
});

describe("completeJSON — reasoning-token usage", () => {
  test("accumulates reasoningTokens across attempts when the provider reports them", async () => {
    let call = 0;
    const reporting: LlmProvider = {
      name: "reporting",
      complete: async () => {
        call++;
        return {
          text: call === 1 ? "not json" : JSON.stringify({ verdict: "pass", reasoning: "ok" }),
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, reasoningTokens: 700 },
        };
      },
    };
    const res = await completeJSON({ schema: Verdict, prompt: "x", provider: reporting, maxTokens: 1500 });
    expect(res.attempts).toBe(2);
    expect(res.usage.reasoningTokens).toBe(1400);
  });

  test("leaves reasoningTokens absent when the provider never reports it (mock/Chat/Anthropic)", async () => {
    const llm = new MockLLM([JSON.stringify({ verdict: "pass", reasoning: "ok" })]);
    const res = await completeJSON({ schema: Verdict, prompt: "x", provider: llm });
    expect(res.usage.reasoningTokens).toBeUndefined();
  });
});
