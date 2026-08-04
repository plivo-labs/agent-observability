// OpenAI adapter — Responses-API transport + auth-style + Chat fallback.
//
// Runs in its OWN file because it mock.module()s ../src/config.js: a sibling test that
// imports the real config first would cache it and the mock would silently no-op.
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { envSchema } from "../src/schema.js";
import { TEST_CONFIG_MODULE_DEFAULTS } from "./fixtures/judge-config.js";

// Mutable config object — the provider reads config.* at call time, so flipping a field
// between tests (mode / auth style) takes effect without re-importing.
const cfg: Record<string, unknown> = {
  OPENAI_API_MODE: "responses",
  OPENAI_AUTH_STYLE: "api-key",
  OPENAI_API_KEY: "test-key",
  OPENAI_BASE_URL: "https://gw.example/openai/v1",
};
mock.module("../src/config.js", () => ({ ...TEST_CONFIG_MODULE_DEFAULTS, config: cfg }));

const { openaiProvider } = await import("../src/llm/providers/openai.js");

const SCHEMA = { name: "writer_output", schema: { type: "object", properties: { ok: { type: "boolean" } } } };
const baseArgs = {
  system: "sys",
  user: "usr",
  model: "gpt-5.5-1",
  maxTokens: 1234,
  signal: AbortSignal.timeout(5_000),
};

let lastReq: { url: string; init: RequestInit } | undefined;
const realFetch = globalThis.fetch;

function stubFetch(response: Response): void {
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    lastReq = { url: String(url), init: init ?? {} };
    return response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  lastReq = undefined;
  cfg.OPENAI_API_MODE = "responses";
  cfg.OPENAI_AUTH_STYLE = "api-key";
  cfg.OPENAI_BASE_URL = "https://gw.example/openai/v1";
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("openaiProvider — Responses API mode", () => {
  test("POSTs to {base}/responses with api-key header and input + text.format body", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          status: "completed",
          output: [{ content: [{ text: '{"ok":true}' }] }],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 },
      ),
    );

    const res = await openaiProvider.complete({ ...baseArgs, jsonSchema: SCHEMA });

    expect(lastReq?.url).toBe("https://gw.example/openai/v1/responses");
    const headers = lastReq?.init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("test-key");
    expect(headers["Authorization"]).toBeUndefined();
    const body = JSON.parse(String(lastReq?.init.body));
    expect(body.model).toBe("gpt-5.5-1");
    expect(body.input).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
    expect(body.max_output_tokens).toBe(1234);
    expect(body.text.format).toEqual({ type: "json_schema", name: "writer_output", strict: true, schema: SCHEMA.schema });
    // parsed result
    expect(res.text).toBe('{"ok":true}');
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  // Wire-shape, not provider-args: the whole failure this parameter fixes happens
  // at the serialized-body level, so assert on the actual JSON that leaves the process.
  test("sends reasoning.effort verbatim when set — including the truthy-but-falsy-looking \"none\"", async () => {
    stubFetch(new Response(JSON.stringify({ status: "completed", output_text: "{}" }), { status: 200 }));
    await openaiProvider.complete({ ...baseArgs, reasoningEffort: "none" });
    const body = JSON.parse(String(lastReq?.init.body));
    expect(body.reasoning).toEqual({ effort: "none" });
  });

  test("omits the reasoning key entirely when unset (not reasoning:{} or reasoning:undefined)", async () => {
    stubFetch(new Response(JSON.stringify({ status: "completed", output_text: "{}" }), { status: 200 }));
    await openaiProvider.complete(baseArgs);
    const body = JSON.parse(String(lastReq?.init.body));
    expect("reasoning" in body).toBe(false);
  });

  test("surfaces output_tokens_details.reasoning_tokens as usage.reasoningTokens", async () => {
    // The invisible spend that bills against max_output_tokens — uninstrumented,
    // it left two prod truncation incidents (2026-07-14, 2026-07-23) undiagnosable
    // from AO's own telemetry.
    stubFetch(
      new Response(
        JSON.stringify({
          status: "completed",
          output_text: "{}",
          usage: { input_tokens: 10, output_tokens: 900, total_tokens: 910, output_tokens_details: { reasoning_tokens: 850 } },
        }),
        { status: 200 },
      ),
    );
    const res = await openaiProvider.complete(baseArgs);
    expect(res.usage.reasoningTokens).toBe(850);
    expect(res.usage.completionTokens).toBe(900);
  });

  test("leaves usage.reasoningTokens absent when the gateway omits output_tokens_details", async () => {
    stubFetch(
      new Response(
        JSON.stringify({ status: "completed", output_text: "{}", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }),
        { status: 200 },
      ),
    );
    const res = await openaiProvider.complete(baseArgs);
    expect(res.usage.reasoningTokens).toBeUndefined();
  });

  test("planner (no jsonSchema) omits text.format", async () => {
    stubFetch(new Response(JSON.stringify({ status: "completed", output_text: "{}" }), { status: 200 }));
    await openaiProvider.complete(baseArgs);
    const body = JSON.parse(String(lastReq?.init.body));
    expect(body.text).toBeUndefined();
    expect(body.input).toHaveLength(2);
  });

  test("bearer auth style sends Authorization, not api-key", async () => {
    cfg.OPENAI_AUTH_STYLE = "bearer";
    stubFetch(new Response(JSON.stringify({ status: "completed", output_text: "{}" }), { status: 200 }));
    await openaiProvider.complete(baseArgs);
    const headers = lastReq?.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    expect(headers["api-key"]).toBeUndefined();
  });

  test("falls back to output_text when output[].content is absent", async () => {
    stubFetch(new Response(JSON.stringify({ status: "completed", output_text: '{"a":1}' }), { status: 200 }));
    const res = await openaiProvider.complete(baseArgs);
    expect(res.text).toBe('{"a":1}');
  });

  test("throws with status + body preview on non-2xx (the 404 case)", async () => {
    stubFetch(new Response("Resource not found", { status: 404, statusText: "Not Found" }));
    await expect(openaiProvider.complete(baseArgs)).rejects.toThrow(/404.*Resource not found/);
  });

  test("throws when the Responses result status is not 'completed'", async () => {
    stubFetch(new Response(JSON.stringify({ status: "incomplete", output: [] }), { status: 200 }));
    await expect(openaiProvider.complete(baseArgs)).rejects.toThrow(/incomplete/);
  });
});

describe("openaiProvider — Chat Completions mode", () => {
  // The user simulator PINS apiMode:"chat", so this path is not a fallback — it is the
  // only transport one production role ever uses. It had no coverage here because it
  // goes through the OpenAI SDK rather than a hand-built fetch; the SDK still issues
  // its request through globalThis.fetch, so the same stub works.
  const chatArgs = { ...baseArgs, apiMode: "chat" as const };

  function chatResponse(usage?: Record<string, unknown>): Response {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "gpt-5.5-1",
        choices: [{ index: 0, message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }],
        usage: usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  // Two SDK quirks force this shape instead of the shared stubFetch:
  //  1. the SDK reads the response body more than once, so a reused Response instance
  //     fails with ERR_BODY_ALREADY_USED — each call needs a fresh one;
  //  2. the SDK captures globalThis.fetch when the client is CONSTRUCTED (memoized in
  //     getClient()), so reassigning globalThis.fetch per test silently keeps the first
  //     stub. Reassigning would let body assertions still pass while every usage
  //     assertion read the first test's response.
  // So: install the stub once, and vary the payload through a mutable the closure reads
  // at request time.
  let nextChatUsage: Record<string, unknown> | undefined;

  function stubChatFetch(usage?: Record<string, unknown>): void {
    nextChatUsage = usage;
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      lastReq = { url: String(url), init: init ?? {} };
      return chatResponse(nextChatUsage);
    }) as unknown as typeof fetch;
  }

  test("POSTs to {base}/chat/completions with messages + response_format", async () => {
    stubChatFetch();
    const res = await openaiProvider.complete({ ...chatArgs, jsonSchema: SCHEMA });

    expect(lastReq?.url).toBe("https://gw.example/openai/v1/chat/completions");
    const body = JSON.parse(String(lastReq?.init.body));
    expect(body.messages[0].role).toBe("system");
    expect(body.response_format.type).toBe("json_schema");
    expect(res.text).toBe('{"ok":true}');
  });

  test("sends reasoning_effort FLAT (not the Responses API's nested reasoning.effort)", async () => {
    // The two OpenAI transports disagree on the wire shape for the same concept.
    // Sending the nested form here would be silently ignored by the gateway, which is
    // indistinguishable from the pre-fix behavior of dropping it entirely.
    stubChatFetch();
    await openaiProvider.complete({ ...chatArgs, jsonSchema: SCHEMA, reasoningEffort: "low" });

    const body = JSON.parse(String(lastReq?.init.body));
    expect(body.reasoning_effort).toBe("low");
    expect(body.reasoning).toBeUndefined();
  });

  test('forwards the truthy-but-falsy-looking "none" rather than treating it as unset', async () => {
    stubChatFetch();
    await openaiProvider.complete({ ...chatArgs, jsonSchema: SCHEMA, reasoningEffort: "none" });
    expect(JSON.parse(String(lastReq?.init.body)).reasoning_effort).toBe("none");
  });

  test("omits reasoning_effort entirely when unset, so a rejecting deployment is unaffected", async () => {
    stubChatFetch();
    await openaiProvider.complete({ ...chatArgs, jsonSchema: SCHEMA });

    const body = JSON.parse(String(lastReq?.init.body));
    expect("reasoning_effort" in body).toBe(false);
  });

  test("omits max_tokens when maxTokens is 0 — the uncapped simulator call", async () => {
    // Load-bearing: this path sends `max_tokens`, which gpt-5.x deployments REJECT on
    // chat/completions. It is safe only because the one caller that pins this mode
    // passes maxTokens:null → 0 → omitted. If this ever starts emitting the key, a
    // reasoning simulator model 400s on every turn.
    stubChatFetch();
    await openaiProvider.complete({ ...chatArgs, maxTokens: 0, jsonSchema: SCHEMA });

    const body = JSON.parse(String(lastReq?.init.body));
    expect("max_tokens" in body).toBe(false);
    expect("max_completion_tokens" in body).toBe(false);
  });

  test("surfaces completion_tokens_details.reasoning_tokens as usage.reasoningTokens", async () => {
    // Chat reports reasoning spend under a DIFFERENT key than Responses
    // (completion_tokens_details vs output_tokens_details). Without this mapping the
    // reasoning-pressure breadcrumb in completeJSON stays blind on this transport.
    stubChatFetch({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      completion_tokens_details: { reasoning_tokens: 3 },
    });
    const res = await openaiProvider.complete({ ...chatArgs, jsonSchema: SCHEMA });
    expect(res.usage.reasoningTokens).toBe(3);
  });

  test("leaves usage.reasoningTokens absent when the gateway omits the details block", async () => {
    stubChatFetch();
    const res = await openaiProvider.complete({ ...chatArgs, jsonSchema: SCHEMA });
    expect(res.usage.reasoningTokens).toBeUndefined();
    expect(res.usage.totalTokens).toBe(15);
  });
});

describe("envSchema — new OpenAI transport knobs", () => {
  const valid = { DATABASE_URL: "postgres://localhost:5432/test" };
  test("default to chat + bearer (vanilla OpenAI, OSS-safe)", () => {
    const r = envSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.OPENAI_API_MODE).toBe("chat");
      expect(r.data.OPENAI_AUTH_STYLE).toBe("bearer");
    }
  });
  test("accept responses + api-key, reject unknown values", () => {
    expect(envSchema.safeParse({ ...valid, OPENAI_API_MODE: "responses", OPENAI_AUTH_STYLE: "api-key" }).success).toBe(true);
    expect(envSchema.safeParse({ ...valid, OPENAI_API_MODE: "grpc" }).success).toBe(false);
    expect(envSchema.safeParse({ ...valid, OPENAI_AUTH_STYLE: "basic" }).success).toBe(false);
  });
});
