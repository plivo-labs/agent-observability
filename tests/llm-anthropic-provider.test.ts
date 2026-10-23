// Own file: it mock.module()s ../src/config.js with an Anthropic key, and the
// SDK client is memoized with the fetch it was constructed with.
import { test, expect, mock } from "bun:test";
import { TEST_CONFIG_MODULE_DEFAULTS } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => ({ ...TEST_CONFIG_MODULE_DEFAULTS, config: { ANTHROPIC_API_KEY: "test-key" } }));

const { anthropicProvider } = await import("../src/llm/providers/anthropic.js");

test("applies no reasoning effort and reports none, even when one is requested", async () => {
  let body: Record<string, unknown> = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      id: "msg_test", type: "message", role: "assistant", model: "claude-test", stop_reason: "tool_use", stop_sequence: null,
      content: [{ type: "tool_use", id: "toolu_test", name: "eval_polite", input: { ok: true } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    const res = await anthropicProvider.complete({
      system: "sys", user: "usr", model: "claude-test", maxTokens: 100, reasoningEffort: "high",
      jsonSchema: { name: "eval_polite", schema: { type: "object", properties: { ok: { type: "boolean" } } } },
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.text).toBe('{"ok":true}');
    expect("thinking" in body || "reasoning" in body).toBe(false);
    expect("reasoningEffort" in res).toBe(false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
