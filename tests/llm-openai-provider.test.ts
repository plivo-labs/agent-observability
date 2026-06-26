// OpenAI adapter — Responses-API transport + auth-style + Chat fallback.
//
// Runs in its OWN file because it mock.module()s ../src/config.js: a sibling test that
// imports the real config first would cache it and the mock would silently no-op.
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { envSchema } from "../src/schema.js";

// Mutable config object — the provider reads config.* at call time, so flipping a field
// between tests (mode / auth style) takes effect without re-importing.
const cfg: Record<string, unknown> = {
  OPENAI_API_MODE: "responses",
  OPENAI_AUTH_STYLE: "api-key",
  OPENAI_API_KEY: "test-key",
  OPENAI_BASE_URL: "https://gw.example/openai/v1",
};
mock.module("../src/config.js", () => ({ config: cfg, dbConfigured: false }));

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
