import { describe, test, expect } from "bun:test";
import { parseChatHistory } from "../src/parse.js";

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

  // ── Preserves original items ───────────────────────────────────────────

  test("returns original items array unchanged", () => {
    const items = [
      { id: "1", type: "message", role: "user", content: "hello" },
      { id: "2", type: "message", role: "assistant", content: "hi there" },
    ];
    const result = parseChatHistory({ items });
    expect(result.chatItems).toEqual(items);
  });
});
