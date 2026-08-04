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
const { __setPricesForTesting, __getPricesForTesting } = await import("../src/evals/pricing.js");
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

describe("completeJSON — usage accounting", () => {
  // completeJSON is the single chokepoint every LLM call in this service passes
  // through, so these `[llm] usage` lines ARE the token accounting. A regression
  // here is silent — nothing throws, the numbers just quietly stop existing —
  // which is exactly how the Luna-vs-5.5 comparison ended up with no cost data.
  function captureUsage(): { lines: string[]; restore: () => void } {
    const original = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("[llm] usage")) lines.push(line);
    };
    return { lines, restore: () => { console.log = original; } };
  }

  /** Parse the `k=v` line back into an object so assertions read as facts. */
  function fields(line: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [, k, v] of line.matchAll(/(\w+)=(\S+)/g)) out[k] = v;
    return out;
  }

  test("emits one line on success carrying label, correlation id and tokens", async () => {
    const cap = captureUsage();
    try {
      await completeJSON({
        schema: Verdict,
        prompt: "x",
        provider: new MockLLM([JSON.stringify({ verdict: "pass", reasoning: "ok" })]),
        role: "generator",
        label: "planner",
        correlationId: "gen-abc",
      });
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(1);
    const f = fields(cap.lines[0]!);
    expect(f.label).toBe("planner");
    expect(f.role).toBe("generator");
    expect(f.correlation_id).toBe("gen-abc");
    expect(f.prompt_tokens).toBe("10");
    expect(f.completion_tokens).toBe("5");
    expect(f.attempts).toBe("1");
    expect(f.outcome).toBe("ok");
  });

  test("falls back to the role when no label is given", async () => {
    const cap = captureUsage();
    try {
      await completeJSON({
        schema: Verdict,
        prompt: "x",
        provider: new MockLLM([JSON.stringify({ verdict: "pass", reasoning: "ok" })]),
        role: "judge",
      });
    } finally {
      cap.restore();
    }
    expect(fields(cap.lines[0]!).label).toBe("judge");
  });

  test("accounts for a FAILED call — retries burned tokens and must still be billed", async () => {
    // Counting only successes would rank the model that fails most as the cheapest.
    const cap = captureUsage();
    try {
      await expect(
        completeJSON({
          schema: Verdict,
          prompt: "x",
          provider: new MockLLM(["bad", "still bad"]),
          label: "writer",
        }),
      ).rejects.toThrow(LlmError);
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(1);
    const f = fields(cap.lines[0]!);
    expect(f.outcome).toBe("error");
    expect(f.attempts).toBe("2");
    expect(f.prompt_tokens).toBe("20"); // both attempts, not just the last
    expect(f.total_tokens).toBe("30");
  });

  test("stays silent when a call is aborted before spending anything", async () => {
    // A request aborted before its first provider call must not push an all-zero
    // row into the accounting stream.
    const cap = captureUsage();
    try {
      await expect(
        completeJSON({
          schema: Verdict,
          prompt: "x",
          provider: new MockLLM([JSON.stringify({ verdict: "pass", reasoning: "ok" })]),
          signal: AbortSignal.abort(),
        }),
      ).rejects.toThrow(LlmError);
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(0);
  });

  test("reports cost_usd=unknown rather than a fabricated 0 for an unpriced model", async () => {
    const cap = captureUsage();
    try {
      await completeJSON({
        schema: Verdict,
        prompt: "x",
        provider: new MockLLM([JSON.stringify({ verdict: "pass", reasoning: "ok" })]),
        model: "some-model-we-have-no-rate-for",
      });
    } finally {
      cap.restore();
    }
    expect(fields(cap.lines[0]!).cost_usd).toBe("unknown");
  });

  test("computes cost from prompt+completion, NOT double-counting reasoning tokens", async () => {
    // reasoningTokens is a subset of completionTokens (the provider already counts
    // invisible reasoning inside output_tokens and bills it at the output rate).
    // Adding it again would silently inflate every reasoning model's reported cost.
    const snapshot = __getPricesForTesting();
    __setPricesForTesting({ "priced:test-model": { input: 100_000, output: 200_000 } });
    const cap = captureUsage();
    try {
      await completeJSON({
        schema: Verdict,
        prompt: "x",
        model: "test-model",
        provider: {
          name: "priced",
          complete: async () => ({
            text: JSON.stringify({ verdict: "pass", reasoning: "ok" }),
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, reasoningTokens: 4 },
          }),
        },
      });
    } finally {
      cap.restore();
      __setPricesForTesting(snapshot);
    }
    const f = fields(cap.lines[0]!);
    // (10 * 100_000 + 5 * 200_000) / 1e6 = 2.0 — reasoning's 4 tokens are already
    // inside the 5 completion tokens and contribute nothing extra.
    expect(f.cost_usd).toBe("2.000000");
    expect(f.reasoning_tokens).toBe("4");
  });
});
