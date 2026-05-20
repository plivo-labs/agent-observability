import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { computeCaseMetrics, costFromSessionUsage } from "../src/evals/metrics.js";
import {
  __setPricesForTesting,
  __resetPricingForTesting,
} from "../src/evals/pricing.js";

describe("computeCaseMetrics", () => {
  test("empty events → all nulls + zero counters + zero tokens", () => {
    const m = computeCaseMetrics([]);
    expect(m.ttft_p50_ms).toBeNull();
    expect(m.ttft_p95_ms).toBeNull();
    expect(m.ttft_avg_ms).toBeNull();
    expect(m.ttfb_p50_ms).toBeNull();
    expect(m.ttfb_p95_ms).toBeNull();
    expect(m.ttfb_avg_ms).toBeNull();
    expect(m.turn_count).toBe(0);
    expect(m.tool_call_count).toBe(0);
    expect(m.interruption_count).toBe(0);
    expect(m.agent_handoff_count).toBe(0);
    expect(m.ttft_sample_count).toBe(0);
    expect(m.prompt_tokens).toBe(0);
    expect(m.completion_tokens).toBe(0);
    expect(m.total_tokens).toBe(0);
    expect(m.cached_prompt_tokens).toBe(0);
  });

  test("single assistant message with TTFT sample", () => {
    const m = computeCaseMetrics([
      { type: "message", role: "assistant", metrics: { llm_node_ttft: 0.5 } },
    ]);
    // Single sample → percentiles all equal that sample.
    expect(m.ttft_p50_ms).toBe(500);
    expect(m.ttft_p95_ms).toBe(500);
    expect(m.ttft_avg_ms).toBe(500);
    expect(m.ttft_sample_count).toBe(1);
    expect(m.turn_count).toBe(1);
    // No TTFB sample → nulls.
    expect(m.ttfb_p50_ms).toBeNull();
  });

  test("multiple TTFT samples: linear-interp percentiles + average", () => {
    // Samples (after *1000): 100, 200, 300, 400, 500 ms — sorted.
    const m = computeCaseMetrics([
      { type: "message", role: "assistant", metrics: { llm_node_ttft: 0.5 } },
      { type: "message", role: "assistant", metrics: { llm_node_ttft: 0.1 } },
      { type: "message", role: "assistant", metrics: { llm_node_ttft: 0.3 } },
      { type: "message", role: "assistant", metrics: { llm_node_ttft: 0.2 } },
      { type: "message", role: "assistant", metrics: { llm_node_ttft: 0.4 } },
    ]);
    expect(m.ttft_p50_ms).toBe(300); // median of 5 sorted samples
    // p95 of [100,200,300,400,500] @ linear interp: 0.95*(5-1)=3.8 →
    // sorted[3] + 0.8*(sorted[4]-sorted[3]) = 400 + 0.8*100 = 480
    expect(m.ttft_p95_ms).toBe(480);
    expect(m.ttft_avg_ms).toBe(300); // (100+200+300+400+500)/5
    expect(m.ttft_sample_count).toBe(5);
    expect(m.turn_count).toBe(5);
  });

  test("TTFB samples track independently of TTFT", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: { llm_node_ttft: 0.4, tts_node_ttfb: 0.08 },
      },
      {
        type: "message",
        role: "assistant",
        metrics: { llm_node_ttft: 0.6, tts_node_ttfb: 0.12 },
      },
    ]);
    expect(m.ttft_p50_ms).toBe(500); // (400+600)/2 interp at p50
    expect(m.ttfb_p50_ms).toBe(100); // (80+120)/2
    expect(m.ttft_sample_count).toBe(2);
  });

  test("interrupted messages count toward interruption_count", () => {
    const m = computeCaseMetrics([
      { type: "message", role: "assistant", interrupted: false },
      { type: "message", role: "assistant", interrupted: true },
      { type: "message", role: "assistant", interrupted: true },
      { type: "message", role: "user", interrupted: true }, // user counts too
    ]);
    expect(m.interruption_count).toBe(3);
    expect(m.turn_count).toBe(3); // 3 assistant messages
  });

  test("function_call increments tool_call_count; output does not", () => {
    const m = computeCaseMetrics([
      { type: "function_call", name: "lookup_order" },
      { type: "function_call", name: "transfer_to_support" },
      { type: "function_call_output", output: "..." },
    ]);
    expect(m.tool_call_count).toBe(2);
  });

  test("agent_handoff increments agent_handoff_count", () => {
    const m = computeCaseMetrics([
      { type: "agent_handoff", from_agent: "GreeterAgent", to_agent: "SupportAgent" },
      { type: "agent_handoff", from_agent: "SupportAgent", to_agent: "RefundAgent" },
    ]);
    expect(m.agent_handoff_count).toBe(2);
  });

  test("camelCase metric keys (Node SDK shape) are accepted", () => {
    // The vitest plugin's snakeifyKeys path is meant to normalize these,
    // but if it ever misses, the server-side computation must still work.
    const m = computeCaseMetrics([
      { type: "message", role: "assistant", metrics: { llmNodeTtft: 0.5 } },
      { type: "message", role: "assistant", metrics: { ttsNodeTtfb: 0.08 } },
    ]);
    expect(m.ttft_p50_ms).toBe(500);
    expect(m.ttfb_p50_ms).toBe(80);
  });

  test("malformed events are skipped, not fatal", () => {
    const m = computeCaseMetrics([
      null,
      undefined,
      "string-not-object",
      42,
      { type: "unknown" },
      { type: "message" }, // no role
      { type: "message", role: "assistant", metrics: "not-a-dict" as any },
      { type: "message", role: "assistant", metrics: { llm_node_ttft: "not-a-number" } },
      { type: "message", role: "assistant", metrics: { llm_node_ttft: -1 } }, // negative
      { type: "message", role: "assistant", metrics: { llm_node_ttft: Number.POSITIVE_INFINITY } },
    ] as unknown[]);
    expect(m.ttft_sample_count).toBe(0);
    expect(m.turn_count).toBe(4); // four "message" + role=assistant
  });

  test("user-message metrics are ignored for TTFT/TTFB but interruption still counts", () => {
    // User messages may carry transcription_delay but never llm_node_ttft.
    // We don't currently mine user-side metrics — they're outside
    // S4's scope. The role check on TTFT/TTFB is implicit since
    // user messages don't carry those keys; this test pins behavior
    // if upstream ever starts emitting them.
    const m = computeCaseMetrics([
      { type: "message", role: "user", metrics: { transcription_delay: 0.12 } },
      { type: "message", role: "user", interrupted: true },
    ]);
    expect(m.ttft_sample_count).toBe(0);
    expect(m.turn_count).toBe(0); // user messages don't count as agent turns
    expect(m.interruption_count).toBe(1);
  });

  test("zero is a valid sample (not treated as 'missing')", () => {
    // Edge case: a 0ms sample shouldn't be dropped — it's a real (if
    // implausibly fast) measurement.
    const m = computeCaseMetrics([
      { type: "message", role: "assistant", metrics: { llm_node_ttft: 0 } },
      { type: "message", role: "assistant", metrics: { llm_node_ttft: 0.4 } },
    ]);
    expect(m.ttft_sample_count).toBe(2);
    expect(m.ttft_avg_ms).toBe(200);
  });

  // ── Token usage ──────────────────────────────────────────────────────────

  test("single assistant message with token metrics", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: {
          llm_prompt_tokens: 100,
          llm_completion_tokens: 25,
          llm_total_tokens: 125,
        },
      },
    ]);
    expect(m.prompt_tokens).toBe(100);
    expect(m.completion_tokens).toBe(25);
    expect(m.total_tokens).toBe(125);
    expect(m.cached_prompt_tokens).toBe(0);
  });

  test("token sums accumulate across multiple assistant messages", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: { llm_prompt_tokens: 100, llm_completion_tokens: 20, llm_total_tokens: 120 },
      },
      {
        type: "message",
        role: "assistant",
        metrics: { llm_prompt_tokens: 150, llm_completion_tokens: 30, llm_total_tokens: 180 },
      },
    ]);
    expect(m.prompt_tokens).toBe(250);
    expect(m.completion_tokens).toBe(50);
    expect(m.total_tokens).toBe(300);
  });

  test("total_tokens trusts the event field when present (not prompt + completion)", () => {
    // Some providers include system/router tokens that make the event's
    // llm_total_tokens > prompt + completion. We don't second-guess —
    // matches the session-side metrics.ts behaviour.
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: { llm_prompt_tokens: 100, llm_completion_tokens: 25, llm_total_tokens: 130 },
      },
    ]);
    expect(m.total_tokens).toBe(130); // not 125
  });

  test("total_tokens falls back to prompt + completion when event field absent", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: { llm_prompt_tokens: 80, llm_completion_tokens: 20 },
      },
    ]);
    expect(m.total_tokens).toBe(100);
  });

  test("cached_prompt_tokens extracted as a subset of prompt_tokens", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: {
          llm_prompt_tokens: 1000,
          llm_completion_tokens: 50,
          llm_cache_read_tokens: 800,
        },
      },
    ]);
    expect(m.prompt_tokens).toBe(1000);
    expect(m.cached_prompt_tokens).toBe(800);
    // Note: cached is NOT added on top of prompt. Cache % = 800/1000 = 80%.
  });

  test("camelCase token keys are accepted (Node SDK shape)", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: {
          llmPromptTokens: 50,
          llmCompletionTokens: 10,
          llmCacheReadTokens: 40,
        },
      },
    ]);
    expect(m.prompt_tokens).toBe(50);
    expect(m.completion_tokens).toBe(10);
    expect(m.cached_prompt_tokens).toBe(40);
    expect(m.total_tokens).toBe(60); // computed since llmTotalTokens absent
  });

  test("malformed token values are skipped (negative, NaN, non-number)", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: {
          llm_prompt_tokens: -10,
          llm_completion_tokens: "twenty" as any,
          llm_total_tokens: Number.POSITIVE_INFINITY,
        },
      },
      {
        type: "message",
        role: "assistant",
        metrics: { llm_prompt_tokens: 50, llm_completion_tokens: 10 },
      },
    ]);
    // First event contributes nothing (all values invalid).
    expect(m.prompt_tokens).toBe(50);
    expect(m.completion_tokens).toBe(10);
    expect(m.total_tokens).toBe(60);
  });

  test("function_call events don't contribute tokens (defensive guard)", () => {
    // Tokens are conceptually per-LLM-call which wraps an assistant
    // message. function_call events shouldn't carry token metrics; if
    // they ever do, we ignore them to avoid double-counting.
    const m = computeCaseMetrics([
      {
        type: "function_call",
        name: "lookup_order",
        metrics: { llm_prompt_tokens: 9999 }, // should NOT be counted
      },
      {
        type: "message",
        role: "assistant",
        metrics: { llm_prompt_tokens: 100, llm_completion_tokens: 20 },
      },
    ]);
    expect(m.prompt_tokens).toBe(100);
    expect(m.tool_call_count).toBe(1);
  });

  test("token counts floor floats (defensive against fractional inputs)", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: { llm_prompt_tokens: 100.7, llm_completion_tokens: 24.4 },
      },
    ]);
    expect(m.prompt_tokens).toBe(100);
    expect(m.completion_tokens).toBe(24);
    expect(m.total_tokens).toBe(124); // 100 + 24, both floored
  });
});

// ── Estimated USD cost ──────────────────────────────────────────────────────

describe("computeCaseMetrics — estimated_cost_usd", () => {
  beforeEach(() => {
    __setPricesForTesting({
      "openai:gpt-4o-mini": { input: 0.15, output: 0.6, cache_read: 0.075 },
      "openai:gpt-4o": { input: 2.5, output: 10 }, // no cache_read
      "anthropic:claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1 },
    });
  });

  afterEach(() => {
    __resetPricingForTesting();
  });

  test("no tokens at all → cost is 0 (start value, never demoted)", () => {
    const m = computeCaseMetrics([]);
    expect(m.estimated_cost_usd).toBe(0);
  });

  test("priced model: cost = prompt @ input + completion @ output, per 1M tokens", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: {
          model_provider: "openai",
          model_name: "gpt-4o-mini",
          llm_prompt_tokens: 1_000_000,
          llm_completion_tokens: 100_000,
        },
      },
    ]);
    // 1M prompt @ $0.15 + 100k completion @ $0.60/M = $0.15 + $0.06 = $0.21
    expect(m.estimated_cost_usd).toBeCloseTo(0.21, 5);
  });

  test("cache_read rate applied to cached portion when present", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: {
          model_provider: "openai",
          model_name: "gpt-4o-mini",
          llm_prompt_tokens: 1_000_000,
          llm_cache_read_tokens: 800_000,
          llm_completion_tokens: 0,
        },
      },
    ]);
    // fresh 200k @ $0.15 + cached 800k @ $0.075 + output 0 = $0.03 + $0.06 = $0.09
    expect(m.estimated_cost_usd).toBeCloseTo(0.09, 5);
  });

  test("cached tokens fall back to regular input rate when cache_read is absent", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: {
          // gpt-4o seed has no cache_read in this test
          model_provider: "openai",
          model_name: "gpt-4o",
          llm_prompt_tokens: 1_000_000,
          llm_cache_read_tokens: 800_000,
          llm_completion_tokens: 0,
        },
      },
    ]);
    // All 1M prompt tokens billed at $2.50/M regardless of cache split = $2.50
    expect(m.estimated_cost_usd).toBeCloseTo(2.5, 5);
  });

  test("cost sums correctly across multiple models in one case", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: {
          model_provider: "openai",
          model_name: "gpt-4o-mini",
          llm_prompt_tokens: 1_000_000,
          llm_completion_tokens: 0,
        },
      },
      {
        type: "message",
        role: "assistant",
        metrics: {
          model_provider: "anthropic",
          model_name: "claude-haiku-4-5",
          llm_prompt_tokens: 1_000_000,
          llm_completion_tokens: 0,
        },
      },
    ]);
    // $0.15 + $1.00 = $1.15
    expect(m.estimated_cost_usd).toBeCloseTo(1.15, 5);
  });

  test("unknown model with tokens → cost is null (conservative)", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: {
          model_provider: "unknown",
          model_name: "mystery-1",
          llm_prompt_tokens: 100,
          llm_completion_tokens: 50,
        },
      },
    ]);
    expect(m.estimated_cost_usd).toBeNull();
  });

  test("mixed priced + unpriced → cost null (any unpriced sample poisons total)", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: {
          model_provider: "openai",
          model_name: "gpt-4o-mini",
          llm_prompt_tokens: 1_000_000,
          llm_completion_tokens: 0,
        },
      },
      {
        type: "message",
        role: "assistant",
        metrics: {
          model_provider: "unknown",
          model_name: "x",
          llm_prompt_tokens: 100,
          llm_completion_tokens: 50,
        },
      },
    ]);
    expect(m.estimated_cost_usd).toBeNull();
  });

  test("provider/model lookup is case-insensitive and strips dated suffixes", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: {
          model_provider: "OpenAI",
          model_name: "gpt-4o-mini-2024-08-06", // dated suffix
          llm_prompt_tokens: 1_000_000,
          llm_completion_tokens: 0,
        },
      },
    ]);
    expect(m.estimated_cost_usd).toBeCloseTo(0.15, 5);
  });

  test("provider/model can come from nested llm_metadata", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: {
          llm_metadata: {
            model_provider: "anthropic",
            model_name: "claude-haiku-4-5",
          },
          llm_prompt_tokens: 1_000_000,
          llm_completion_tokens: 0,
        },
      },
    ]);
    expect(m.estimated_cost_usd).toBeCloseTo(1, 5);
  });

  test("standalone usage event also contributes cost", () => {
    const m = computeCaseMetrics([
      {
        type: "usage",
        model_provider: "openai",
        model_name: "gpt-4o-mini",
        llm_prompt_tokens: 1_000_000,
        llm_completion_tokens: 0,
      },
    ]);
    expect(m.estimated_cost_usd).toBeCloseTo(0.15, 5);
    expect(m.prompt_tokens).toBe(1_000_000);
  });

  test("priced model but zero tokens → $0.00 (not null)", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: {
          model_provider: "openai",
          model_name: "gpt-4o-mini",
          llm_prompt_tokens: 0,
          llm_completion_tokens: 0,
        },
      },
    ]);
    expect(m.estimated_cost_usd).toBe(0);
  });

  test("OpenAI prompt_tokens_details.cached_tokens path is also recognised", () => {
    const m = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: {
          model_provider: "openai",
          model_name: "gpt-4o-mini",
          llm_prompt_tokens: 1_000_000,
          prompt_tokens_details: { cached_tokens: 800_000 },
          llm_completion_tokens: 0,
        },
      },
    ]);
    // Same expected cost as the explicit `llm_cache_read_tokens` test
    // above ($0.09) — confirms the nested-OpenAI-style path resolves.
    expect(m.estimated_cost_usd).toBeCloseTo(0.09, 5);
    expect(m.cached_prompt_tokens).toBe(800_000);
  });
});

describe("costFromSessionUsage", () => {
  beforeEach(() => {
    __setPricesForTesting({
      "openai:gpt-4o-mini": { input: 0.15, output: 0.6, cache_read: 0.075 },
      "openai:gpt-4o": { input: 2.5, output: 10 },
    });
  });

  afterEach(() => {
    __resetPricingForTesting();
  });

  test("non-array input → null", () => {
    expect(costFromSessionUsage(null)).toBeNull();
    expect(costFromSessionUsage(undefined)).toBeNull();
    expect(costFromSessionUsage({})).toBeNull();
    expect(costFromSessionUsage("not an array")).toBeNull();
    expect(costFromSessionUsage(42)).toBeNull();
  });

  test("empty array → null (no LLM samples)", () => {
    expect(costFromSessionUsage([])).toBeNull();
  });

  test("array with only tts_usage / stt_usage entries → null", () => {
    expect(
      costFromSessionUsage([
        { type: "tts_usage", input_tokens: 100, output_tokens: 50 },
        { type: "stt_usage", audio_duration: 12.5 },
      ]),
    ).toBeNull();
  });

  test("single llm_usage entry → priced cost", () => {
    const cost = costFromSessionUsage([
      {
        type: "llm_usage",
        provider: "openai",
        model: "gpt-4o-mini",
        input_tokens: 1_000_000,
        output_tokens: 100_000,
      },
    ]);
    // 1M prompt @ $0.15 + 100k completion @ $0.60/M = $0.21
    expect(cost).toBeCloseTo(0.21, 5);
  });

  test("multiple llm_usage entries sum across calls", () => {
    const cost = costFromSessionUsage([
      {
        type: "llm_usage",
        provider: "openai",
        model: "gpt-4o-mini",
        input_tokens: 1_000_000,
        output_tokens: 0,
      },
      {
        type: "llm_usage",
        provider: "openai",
        model: "gpt-4o",
        input_tokens: 0,
        output_tokens: 1_000_000,
      },
    ]);
    // 1M @ $0.15 (mini input) + 1M @ $10 (4o output) = $10.15
    expect(cost).toBeCloseTo(10.15, 4);
  });

  test("llm_usage mixed with tts/stt: only LLM contributes to cost", () => {
    const cost = costFromSessionUsage([
      {
        type: "llm_usage",
        provider: "openai",
        model: "gpt-4o-mini",
        input_tokens: 1_000_000,
        output_tokens: 0,
      },
      // These two would normally null-poison summarizeUsage because
      // their model isn't in the price table; the filter on type ==
      // 'llm_usage' keeps them out.
      {
        type: "tts_usage",
        provider: "api.openai.com",
        model: "gpt-4o-mini-tts",
        input_tokens: 78,
        output_tokens: 632,
      },
      {
        type: "stt_usage",
        provider: "Deepgram",
        model: "nova-3",
        audio_duration: 30,
      },
    ]);
    // Only the LLM sample is priced: 1M @ $0.15 = $0.15
    expect(cost).toBeCloseTo(0.15, 5);
  });

  test("llm_usage with unknown model → null (poisoned by unpriced sample)", () => {
    const cost = costFromSessionUsage([
      {
        type: "llm_usage",
        provider: "unknown",
        model: "mystery-model",
        input_tokens: 1000,
        output_tokens: 500,
      },
    ]);
    expect(cost).toBeNull();
  });

  test("malformed entries (non-object) are skipped", () => {
    const cost = costFromSessionUsage([
      null,
      "string entry",
      42,
      {
        type: "llm_usage",
        provider: "openai",
        model: "gpt-4o-mini",
        input_tokens: 1_000_000,
        output_tokens: 0,
      },
    ]);
    // Only the well-formed LLM entry contributes: $0.15
    expect(cost).toBeCloseTo(0.15, 5);
  });
});
