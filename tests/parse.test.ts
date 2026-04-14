import { describe, test, expect } from "bun:test";
import { parseChatHistory, normalizeKeys } from "../src/parse.js";

describe("parseChatHistory", () => {
  test("returns defaults for null input", () => {
    const result = parseChatHistory(null);
    expect(result.chatItems).toEqual([]);
    expect(result.turnCount).toBe(0);
    expect(result.hasStt).toBe(false);
    expect(result.hasLlm).toBe(false);
    expect(result.hasTts).toBe(false);
    expect(result.metrics).toEqual([]);
  });

  test("returns defaults for empty items", () => {
    const result = parseChatHistory({ items: [] });
    expect(result.turnCount).toBe(0);
    expect(result.hasStt).toBe(false);
    expect(result.hasLlm).toBe(false);
    expect(result.hasTts).toBe(false);
  });

  test("returns defaults when items key is missing", () => {
    const result = parseChatHistory({});
    expect(result.chatItems).toEqual([]);
    expect(result.turnCount).toBe(0);
  });

  // ── Turn counting ───────────────────────────────────────────────────────

  test("counts message-type items as turns", () => {
    const result = parseChatHistory({
      items: [
        { type: "message", role: "user" },
        { type: "message", role: "assistant" },
      ],
    });
    expect(result.turnCount).toBe(2);
  });

  test("does not count non-message items as turns", () => {
    const result = parseChatHistory({
      items: [
        { type: "message", role: "user" },
        { type: "function_call", role: "assistant" },
        { type: "function_call_output" },
      ],
    });
    expect(result.turnCount).toBe(1);
  });

  // ── STT detection ───────────────────────────────────────────────────────

  test("detects STT from user-role message", () => {
    const result = parseChatHistory({
      items: [{ type: "message", role: "user" }],
    });
    expect(result.hasStt).toBe(true);
  });

  test("detects STT from transcription_delay metric", () => {
    const result = parseChatHistory({
      items: [{ type: "message", role: "assistant", metrics: { transcription_delay: 0.15 } }],
    });
    expect(result.hasStt).toBe(true);
  });

  test("no STT when only assistant messages without transcription metric", () => {
    const result = parseChatHistory({
      items: [{ type: "message", role: "assistant" }],
    });
    expect(result.hasStt).toBe(false);
  });

  // ── LLM detection ──────────────────────────────────────────────────────

  test("detects LLM from llm_node_ttft metric", () => {
    const result = parseChatHistory({
      items: [{ type: "message", role: "assistant", metrics: { llm_node_ttft: 0.3 } }],
    });
    expect(result.hasLlm).toBe(true);
  });

  test("no LLM when metric is absent", () => {
    const result = parseChatHistory({
      items: [{ type: "message", role: "assistant" }],
    });
    expect(result.hasLlm).toBe(false);
  });

  // ── TTS detection ──────────────────────────────────────────────────────

  test("detects TTS from assistant-role message", () => {
    const result = parseChatHistory({
      items: [{ type: "message", role: "assistant" }],
    });
    expect(result.hasTts).toBe(true);
  });

  test("detects TTS from tts_node_ttfb metric", () => {
    const result = parseChatHistory({
      items: [{ type: "message", role: "user", metrics: { tts_node_ttfb: 0.1 } }],
    });
    expect(result.hasTts).toBe(true);
  });

  // ── Role fallback ──────────────────────────────────────────────────────

  test("falls back to message.role when top-level role is missing", () => {
    const result = parseChatHistory({
      items: [{ type: "message", message: { role: "user" } }],
    });
    expect(result.hasStt).toBe(true);
    expect(result.turnCount).toBe(1);
  });

  // ── Metrics extraction ─────────────────────────────────────────────────

  test("extracts metrics with item_id and role", () => {
    const result = parseChatHistory({
      items: [
        {
          id: "item-1",
          type: "message",
          role: "assistant",
          metrics: { llm_node_ttft: 0.3, tts_node_ttfb: 0.1 },
        },
      ],
    });
    expect(result.metrics).toEqual([
      { item_id: "item-1", role: "assistant", llm_node_ttft: 0.3, tts_node_ttfb: 0.1 },
    ]);
  });

  test("skips items with no metrics", () => {
    const result = parseChatHistory({
      items: [
        { id: "item-1", type: "message", role: "user" },
        { id: "item-2", type: "message", role: "assistant", metrics: { llm_node_ttft: 0.5 } },
      ],
    });
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0].item_id).toBe("item-2");
  });

  test("skips items with empty metrics object", () => {
    const result = parseChatHistory({
      items: [{ id: "item-1", type: "message", role: "user", metrics: {} }],
    });
    expect(result.metrics).toEqual([]);
  });

  // ── Full conversation scenario ─────────────────────────────────────────

  test("parses a realistic multi-turn conversation", () => {
    const result = parseChatHistory({
      items: [
        {
          id: "msg-1",
          type: "message",
          role: "user",
          metrics: { transcription_delay: 0.12 },
        },
        {
          id: "msg-2",
          type: "message",
          role: "assistant",
          metrics: { llm_node_ttft: 0.45, tts_node_ttfb: 0.08 },
        },
        {
          id: "fc-1",
          type: "function_call",
          role: "assistant",
          metrics: { llm_node_ttft: 0.2 },
        },
        {
          id: "fco-1",
          type: "function_call_output",
        },
        {
          id: "msg-3",
          type: "message",
          role: "user",
          metrics: { transcription_delay: 0.1 },
        },
        {
          id: "msg-4",
          type: "message",
          role: "assistant",
          metrics: { llm_node_ttft: 0.38, tts_node_ttfb: 0.07 },
        },
      ],
    });

    expect(result.turnCount).toBe(4);
    expect(result.hasStt).toBe(true);
    expect(result.hasLlm).toBe(true);
    expect(result.hasTts).toBe(true);
    expect(result.chatItems).toHaveLength(6);
    expect(result.metrics).toHaveLength(5); // all items with non-empty metrics
  });

  // ── Wrapped format (report.to_dict()) ────────────────────────────────────

  test("parses wrapped format with chat_history key", () => {
    const result = parseChatHistory({
      chat_history: {
        items: [
          { id: "u1", type: "message", role: "user" },
          { id: "a1", type: "message", role: "assistant" },
        ],
      },
      usage: [{ provider: "openai", model: "gpt-4", input_tokens: 100 }],
    });
    expect(result.chatItems).toHaveLength(2);
    expect(result.turnCount).toBe(2);
  });

  // ── camelCase normalization (Node SDK) ──────────────────────────────────

  test("normalizes camelCase keys to snake_case", () => {
    const result = parseChatHistory({
      items: [
        {
          id: "a1",
          type: "message",
          role: "assistant",
          createdAt: 1776067486653,
          metrics: {
            llmNodeTtft: 1.23,
            ttsNodeTtfb: 2.45,
            startedSpeakingAt: 1776067489.112,
            stoppedSpeakingAt: 1776067495.285,
          },
        },
      ],
    });
    const item = result.chatItems[0];
    expect(item.created_at).toBe(1776067486653);
    expect(item.metrics.llm_node_ttft).toBe(1.23);
    expect(item.metrics.tts_node_ttfb).toBe(2.45);
    expect(item.metrics.started_speaking_at).toBe(1776067489.112);
  });

  test("detects LLM from camelCase llmNodeTtft", () => {
    const result = parseChatHistory({
      items: [
        { type: "message", role: "assistant", metrics: { llmNodeTtft: 0.5 } },
      ],
    });
    expect(result.hasLlm).toBe(true);
  });

  test("detects STT from camelCase transcriptionDelay", () => {
    const result = parseChatHistory({
      items: [
        { type: "message", role: "user", metrics: { transcriptionDelay: 0.3 } },
      ],
    });
    expect(result.hasStt).toBe(true);
  });

  test("normalizes nested camelCase in wrapped format", () => {
    const result = parseChatHistory({
      chatHistory: {
        items: [
          {
            id: "u1",
            type: "message",
            role: "user",
            transcriptConfidence: 0.98,
            metrics: { endOfTurnDelay: 0.5 },
          },
        ],
      },
    });
    const item = result.chatItems[0];
    expect(item.transcript_confidence).toBe(0.98);
    expect(item.metrics.end_of_turn_delay).toBe(0.5);
  });

  test("normalizes agent_handoff newAgentId", () => {
    const result = parseChatHistory({
      items: [
        { type: "agent_handoff", newAgentId: "greeter", createdAt: 123 },
      ],
    });
    expect(result.chatItems[0].new_agent_id).toBe("greeter");
    expect(result.chatItems[0].created_at).toBe(123);
  });

  // ── snake_case passthrough (Python SDK) ─────────────────────────────────

  test("preserves snake_case keys unchanged", () => {
    const result = parseChatHistory({
      items: [
        {
          id: "a1",
          type: "message",
          role: "assistant",
          created_at: 1776050852.977898,
          metrics: {
            llm_node_ttft: 1.21,
            tts_node_ttfb: 1.22,
            llm_metadata: { model_name: "gpt-4.1", model_provider: "openai" },
          },
        },
      ],
    });
    const item = result.chatItems[0];
    expect(item.created_at).toBe(1776050852.977898);
    expect(item.metrics.llm_node_ttft).toBe(1.21);
    expect(item.metrics.llm_metadata.model_name).toBe("gpt-4.1");
  });
});

// ── normalizeKeys ────────────────────────────────────────────────────────────

describe("normalizeKeys", () => {
  test("converts camelCase to snake_case", () => {
    const result = normalizeKeys({ llmNodeTtft: 1.5, ttsNodeTtfb: 2.0 });
    expect(result).toEqual({ llm_node_ttft: 1.5, tts_node_ttfb: 2.0 });
  });

  test("handles nested objects", () => {
    const result = normalizeKeys({
      llmMetadata: { modelName: "gpt-4", modelProvider: "openai" },
    });
    expect(result).toEqual({
      llm_metadata: { model_name: "gpt-4", model_provider: "openai" },
    });
  });

  test("handles arrays", () => {
    const result = normalizeKeys([
      { inputTokens: 100, outputTokens: 20 },
      { charactersCount: 50 },
    ]);
    expect(result).toEqual([
      { input_tokens: 100, output_tokens: 20 },
      { characters_count: 50 },
    ]);
  });

  test("passes through null and primitives", () => {
    expect(normalizeKeys(null)).toBeNull();
    expect(normalizeKeys(undefined)).toBeUndefined();
    expect(normalizeKeys(42)).toBe(42);
    expect(normalizeKeys("hello")).toBe("hello");
  });

  test("preserves snake_case keys unchanged", () => {
    const input = { input_tokens: 100, model_name: "gpt-4" };
    expect(normalizeKeys(input)).toEqual(input);
  });
});
