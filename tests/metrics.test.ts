import { describe, test, expect } from "bun:test";
import { buildSessionMetrics } from "../src/metrics.js";

describe("buildSessionMetrics", () => {
  // ── Null / empty inputs ──────────────────────────────────────────────────

  test("returns null when both chatHistory and sessionMetrics are null", () => {
    expect(buildSessionMetrics(null, null, 0)).toBeNull();
  });

  test("returns null when both are empty arrays", () => {
    expect(buildSessionMetrics([], null, 0)).toBeNull();
  });

  // ── Basic turn building ──────────────────────────────────────────────────

  test("builds a single user-assistant turn", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hello" },
      { id: "a1", type: "message", role: "assistant", content: "hi there" },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].turn_number).toBe(1);
    expect(result.turns[0].user_text).toBe("hello");
    expect(result.turns[0].agent_text).toBe("hi there");
    expect(result.turns[0].agent_first).toBe(false);
  });

  test("builds multiple turns", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi" },
      { id: "a1", type: "message", role: "assistant", content: "hello" },
      { id: "u2", type: "message", role: "user", content: "how are you" },
      { id: "a2", type: "message", role: "assistant", content: "good" },
    ];
    const result = buildSessionMetrics(chat, null, 2)!;
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0].user_text).toBe("hi");
    expect(result.turns[1].user_text).toBe("how are you");
  });

  test("marks agent_first when assistant speaks without preceding user message", () => {
    const chat = [
      { id: "a1", type: "message", role: "assistant", content: "welcome!" },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.turns[0].agent_first).toBe(true);
    expect(result.turns[0].user_text).toBeNull();
  });

  // ── Content normalization ────────────────────────────────────────────────

  test("joins array content into a single string", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: ["hello", "world"] },
      { id: "a1", type: "message", role: "assistant", content: ["hi", "there"] },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.turns[0].user_text).toBe("hello world");
    expect(result.turns[0].agent_text).toBe("hi there");
  });

  test("falls back to message.content when top-level content missing", () => {
    const chat = [
      { id: "u1", type: "message", message: { role: "user", content: "hi" } },
      { id: "a1", type: "message", message: { role: "assistant", content: "hey" } },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.turns[0].user_text).toBe("hi");
    expect(result.turns[0].agent_text).toBe("hey");
  });

  // ── Latency conversion (seconds → ms) ───────────────────────────────────

  test("converts metric values from seconds to milliseconds", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi",
        metrics: { transcription_delay: 0.12 } },
      { id: "a1", type: "message", role: "assistant", content: "hey",
        metrics: { llm_node_ttft: 0.45, tts_node_ttfb: 0.08 } },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.turns[0].stt_delay_ms).toBe(120);
    expect(result.turns[0].llm_ttft_ms).toBe(450);
    expect(result.turns[0].tts_ttfb_ms).toBe(80);
  });

  test("computes user_perceived_ms from e2e_latency when available", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi" },
      { id: "a1", type: "message", role: "assistant", content: "hey",
        metrics: { e2e_latency: 0.6, llm_node_ttft: 0.45, tts_node_ttfb: 0.08 } },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.turns[0].user_perceived_ms).toBe(600);
  });

  test("computes user_perceived_ms as llm + tts when e2e not available", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi" },
      { id: "a1", type: "message", role: "assistant", content: "hey",
        metrics: { llm_node_ttft: 0.45, tts_node_ttfb: 0.08 } },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.turns[0].user_perceived_ms).toBe(530);
  });

  // ── Metrics lookup from sessionMetrics by item_id ────────────────────────

  test("merges metrics from sessionMetrics JSONB by item_id", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi" },
      { id: "a1", type: "message", role: "assistant", content: "hey" },
    ];
    const sessionMetrics = [
      { item_id: "u1", transcription_delay: 0.15 },
      { item_id: "a1", llm_node_ttft: 0.3 },
    ];
    const result = buildSessionMetrics(chat, sessionMetrics, 1)!;
    expect(result.turns[0].stt_delay_ms).toBe(150);
    expect(result.turns[0].llm_ttft_ms).toBe(300);
  });

  // ── Token tracking ───────────────────────────────────────────────────────

  test("tracks token usage per turn and in summary", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi" },
      { id: "a1", type: "message", role: "assistant", content: "hey",
        metrics: { llm_prompt_tokens: 10, llm_completion_tokens: 5, llm_total_tokens: 15 } },
      { id: "u2", type: "message", role: "user", content: "ok" },
      { id: "a2", type: "message", role: "assistant", content: "bye",
        metrics: { llm_prompt_tokens: 20, llm_completion_tokens: 8, llm_total_tokens: 28 } },
    ];
    const result = buildSessionMetrics(chat, null, 2)!;
    expect(result.turns[0].llm_total_tokens).toBe(15);
    expect(result.turns[1].llm_total_tokens).toBe(28);
    expect(result.summary.total_llm_tokens).toBe(43);
  });

  test("computes llm_total_tokens from prompt + completion when total absent", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi" },
      { id: "a1", type: "message", role: "assistant", content: "hey",
        metrics: { llm_prompt_tokens: 10, llm_completion_tokens: 5 } },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.turns[0].llm_total_tokens).toBe(15);
  });

  // ── TTS character tracking ───────────────────────────────────────────────

  test("counts TTS characters from agent text length", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi" },
      { id: "a1", type: "message", role: "assistant", content: "hello there" },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.turns[0].tts_characters).toBe(11);
    expect(result.summary.total_tts_characters).toBe(11);
  });

  // ── Tool calls ───────────────────────────────────────────────────────────

  test("collects tool calls and attaches to the following turn", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "what's the weather?" },
      { id: "fc1", type: "function_call", name: "get_weather",
        arguments: { city: "NYC" }, call_id: "call-1", timestamp: "2025-01-01T00:00:00Z" },
      { id: "a1", type: "message", role: "assistant", content: "It's sunny" },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.turns[0].tool_calls).toHaveLength(1);
    expect(result.turns[0].tool_calls![0].name).toBe("get_weather");
    expect(result.tool_calls).toHaveLength(1);
    expect(result.summary.total_tool_calls).toBe(1);
  });

  test("handles tool_call type items", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "search" },
      { id: "tc1", type: "tool_call", name: "search_db",
        arguments: { q: "test" }, timestamp: "2025-01-01T00:00:00Z" },
      { id: "a1", type: "message", role: "assistant", content: "found it" },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.turns[0].tool_calls).toHaveLength(1);
    expect(result.turns[0].tool_calls![0].name).toBe("search_db");
  });

  // ── Interruptions ────────────────────────────────────────────────────────

  test("tracks interrupted turns", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi" },
      { id: "a1", type: "message", role: "assistant", content: "hel--", interrupted: true },
      { id: "u2", type: "message", role: "user", content: "stop" },
      { id: "a2", type: "message", role: "assistant", content: "ok" },
    ];
    const result = buildSessionMetrics(chat, null, 2)!;
    expect(result.turns[0].interrupted).toBe(true);
    expect(result.turns[1].interrupted).toBe(false);
    expect(result.summary.interruptions).toBe(1);
  });

  // ── Dangling user message ────────────────────────────────────────────────

  test("handles user message without agent response", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hello?" },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].user_text).toBe("hello?");
    expect(result.turns[0].agent_text).toBeNull();
  });

  // ── Summary statistics ─────────────────────────────────────────────────

  test("computes average and p95 user perceived latency", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "a" },
      { id: "a1", type: "message", role: "assistant", content: "b",
        metrics: { e2e_latency: 0.5 } },
      { id: "u2", type: "message", role: "user", content: "c" },
      { id: "a2", type: "message", role: "assistant", content: "d",
        metrics: { e2e_latency: 0.3 } },
      { id: "u3", type: "message", role: "user", content: "e" },
      { id: "a3", type: "message", role: "assistant", content: "f",
        metrics: { e2e_latency: 0.7 } },
    ];
    const result = buildSessionMetrics(chat, null, 3)!;
    expect(result.summary.avg_user_perceived_ms).toBe(500); // (500+300+700)/3
    expect(result.summary.p95_user_perceived_ms).toBe(700);
  });

  test("falls back to turnCount for total_turns when no turns parsed", () => {
    // sessionMetrics present but chatHistory empty → not null, but no turns
    const result = buildSessionMetrics([], [{ item_id: "x", llm_node_ttft: 0.1 }], 5)!;
    expect(result.summary.total_turns).toBe(5);
  });

  test("omits perceived latency stats when no values available", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi" },
      { id: "a1", type: "message", role: "assistant", content: "hey" },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.summary.avg_user_perceived_ms).toBeUndefined();
    expect(result.summary.p95_user_perceived_ms).toBeUndefined();
  });

  // ── Speaking timestamps ──────────────────────────────────────────────────

  test("maps speaking timestamps to ISO strings", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi",
        metrics: { started_speaking_at: 1776050854.676, stopped_speaking_at: 1776050856.999 } },
      { id: "a1", type: "message", role: "assistant", content: "hey",
        metrics: { started_speaking_at: 1776050859.776, stopped_speaking_at: 1776050864.359 } },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.turns[0].user_started_speaking_at).toContain("2026-");
    expect(result.turns[0].user_stopped_speaking_at).toContain("2026-");
    expect(result.turns[0].agent_started_speaking_at).toContain("2026-");
    expect(result.turns[0].agent_stopped_speaking_at).toContain("2026-");
  });

  test("handles missing speaking timestamps gracefully", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi" },
      { id: "a1", type: "message", role: "assistant", content: "hey" },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.turns[0].user_started_speaking_at).toBeUndefined();
    expect(result.turns[0].agent_started_speaking_at).toBeUndefined();
  });

  // ── Turn decision ───────────────────────────────────────────────────────

  test("maps end_of_turn_delay to turn_decision_ms", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi",
        metrics: { end_of_turn_delay: 0.635 } },
      { id: "a1", type: "message", role: "assistant", content: "hey",
        metrics: { llm_node_ttft: 0.3 } },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.turns[0].turn_decision_ms).toBe(635);
  });

  // ── Provider metadata ───────────────────────────────────────────────────

  test("maps provider metadata from stt/llm/tts_metadata", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi",
        metrics: { stt_metadata: { model_name: "nova-3", model_provider: "Deepgram" } } },
      { id: "a1", type: "message", role: "assistant", content: "hey",
        metrics: {
          llm_metadata: { model_name: "gpt-4.1", model_provider: "openai" },
          tts_metadata: { model_name: "tts-1", model_provider: "openai" },
        } },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    expect(result.turns[0].stt_provider).toBe("Deepgram");
    expect(result.turns[0].stt_model).toBe("nova-3");
    expect(result.turns[0].llm_provider).toBe("openai");
    expect(result.turns[0].llm_model).toBe("gpt-4.1");
    expect(result.turns[0].tts_provider).toBe("openai");
    expect(result.turns[0].tts_model).toBe("tts-1");
  });

  test("derives summary providers from first turn with metadata", () => {
    const chat = [
      { id: "a1", type: "message", role: "assistant", content: "welcome" },
      { id: "u1", type: "message", role: "user", content: "hi",
        metrics: { stt_metadata: { model_name: "nova-3", model_provider: "Deepgram" } } },
      { id: "a2", type: "message", role: "assistant", content: "hey",
        metrics: {
          llm_metadata: { model_name: "gpt-4", model_provider: "openai" },
          tts_metadata: { model_name: "tts-1", model_provider: "openai" },
        } },
    ];
    const result = buildSessionMetrics(chat, null, 2)!;
    expect(result.summary.providers).toBeDefined();
    expect(result.summary.providers!.stt_provider).toBe("Deepgram");
    expect(result.summary.providers!.llm_provider).toBe("openai");
  });

  // ── Usage-level token extraction ────────────────────────────────────────

  test("extracts tokens from session-level usage when per-turn tokens missing", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi" },
      { id: "a1", type: "message", role: "assistant", content: "hey" },
    ];
    const sessionMetrics = {
      per_turn: [],
      usage: [
        { provider: "openai", model: "gpt-4", input_tokens: 787, output_tokens: 23 },
        { provider: "openai", model: "tts-1", input_tokens: 30, output_tokens: 195, characters_count: 94 },
      ],
    };
    const result = buildSessionMetrics(chat, sessionMetrics, 1)!;
    expect(result.summary.total_llm_tokens).toBe(810);
    expect(result.summary.total_llm_prompt_tokens).toBe(787);
    expect(result.summary.total_llm_completion_tokens).toBe(23);
    // TTS characters come from text length (3 = "hey".length), not usage
    // Usage fallback only applies when per-turn total is 0
    expect(result.summary.total_tts_characters).toBe(3);
  });

  test("prefers per-turn tokens over session-level usage", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi" },
      { id: "a1", type: "message", role: "assistant", content: "hey",
        metrics: { llm_prompt_tokens: 50, llm_completion_tokens: 10, llm_total_tokens: 60 } },
    ];
    const sessionMetrics = {
      per_turn: [],
      usage: [{ provider: "openai", model: "gpt-4", input_tokens: 787, output_tokens: 23 }],
    };
    const result = buildSessionMetrics(chat, sessionMetrics, 1)!;
    // Per-turn tokens should be used, not session-level
    expect(result.summary.total_llm_tokens).toBe(60);
  });

  // ── Speaking timestamp collision ────────────────────────────────────────

  test("separates user and agent speaking timestamps (collision avoidance)", () => {
    const chat = [
      { id: "u1", type: "message", role: "user", content: "hi",
        metrics: { started_speaking_at: 1000.0, stopped_speaking_at: 1002.0 } },
      { id: "a1", type: "message", role: "assistant", content: "hey",
        metrics: { started_speaking_at: 1005.0, stopped_speaking_at: 1008.0 } },
    ];
    const result = buildSessionMetrics(chat, null, 1)!;
    // User timestamps from user metrics (not overwritten by assistant)
    expect(result.turns[0].user_started_speaking_at).toContain("1970-01-01T00:16:40");
    // Agent timestamps from assistant metrics
    expect(result.turns[0].agent_started_speaking_at).toContain("1970-01-01T00:16:45");
  });
});
