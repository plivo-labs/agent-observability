import OpenAI from "openai";
import { config } from "../../config.js";
import type { LlmProvider, ProviderCompleteArgs, RawCompletion, LlmUsage } from "../types.js";

let client: OpenAI | undefined;

function getClient(): OpenAI {
  if (!config.OPENAI_API_KEY) {
    throw new Error("LLM_PROVIDER=openai but OPENAI_API_KEY is not set");
  }
  if (!client) {
    // OPENAI_BASE_URL covers Azure OpenAI / OpenRouter / a local server.
    // For api-key gateways, send the api-key header alongside the SDK's default
    // Authorization (the gateway uses whichever it recognizes).
    const defaultHeaders =
      config.OPENAI_AUTH_STYLE === "api-key" ? { "api-key": config.OPENAI_API_KEY } : undefined;
    client = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      baseURL: config.OPENAI_BASE_URL || undefined,
      defaultHeaders,
    });
  }
  return client;
}

/** Chat Completions wire format: POST {base}/chat/completions with `messages` + `response_format`. */
async function completeViaChat(args: ProviderCompleteArgs): Promise<RawCompletion> {
  const { system, user, model, maxTokens, temperature, topP, jsonSchema, signal } = args;
  // Strict json_schema when a schema is supplied (guarantees required fields);
  // otherwise the looser json_object (valid-JSON-only) mode.
  const response_format = jsonSchema
    ? ({ type: "json_schema", json_schema: { name: jsonSchema.name, strict: jsonSchema.strict ?? true, schema: jsonSchema.schema } } as const)
    : ({ type: "json_object" } as const);
  const res = await getClient().chat.completions.create(
    {
      model,
      // maxTokens === 0 means "no cap" → omit so the model uses its default budget.
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      response_format,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { top_p: topP } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    { signal },
  );

  return {
    text: res.choices[0]?.message?.content ?? "",
    usage: {
      promptTokens: res.usage?.prompt_tokens ?? 0,
      completionTokens: res.usage?.completion_tokens ?? 0,
      totalTokens: res.usage?.total_tokens ?? 0,
    },
  };
}

interface ResponsesResult {
  status?: string;
  incomplete_details?: { reason?: string };
  output?: { content?: { text?: string }[] }[];
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

/** Join the text chunks out of a Responses API result (output[].content[].text), with the
 *  flat output_text as a fallback. Mirrors the reference Responses-API consumers. */
function extractResponsesText(r: ResponsesResult): string {
  const chunks: string[] = [];
  for (const out of r.output ?? []) {
    for (const c of out.content ?? []) {
      if (typeof c.text === "string") chunks.push(c.text);
    }
  }
  if (chunks.length) return chunks.join("");
  return typeof r.output_text === "string" ? r.output_text : "";
}

/**
 * Responses API wire format: POST {base}/responses with `input` + `text.format`.
 * Raw fetch (not the SDK) so the path + auth header are exactly what api-key gateways
 * expect — the SDK's baseURL override assumes Chat Completions + Bearer, which 404s on
 * Responses-only gateways. Honors the abort signal for the per-attempt timeout.
 */
async function completeViaResponses(args: ProviderCompleteArgs): Promise<RawCompletion> {
  const { system, user, model, maxTokens, temperature, topP, jsonSchema, signal } = args;
  if (!config.OPENAI_API_KEY) {
    throw new Error("LLM_PROVIDER=openai but OPENAI_API_KEY is not set");
  }
  const base = (config.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = `${base}/responses`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.OPENAI_AUTH_STYLE === "api-key") headers["api-key"] = config.OPENAI_API_KEY;
  else headers["Authorization"] = `Bearer ${config.OPENAI_API_KEY}`;

  const body: Record<string, unknown> = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { top_p: topP } : {}),
    // Strict structured output when a schema is supplied; otherwise free JSON (the
    // planner relies on the JSON_ONLY_HINT + zod validation in completeJSON).
    ...(jsonSchema
      ? { text: { format: { type: "json_schema", name: jsonSchema.name, strict: jsonSchema.strict ?? true, schema: jsonSchema.schema } } }
      : {}),
  };

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const preview = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`${res.status} ${res.statusText}${preview ? ` - ${preview}` : ""}`.trim());
  }
  const json = (await res.json()) as ResponsesResult;
  // The Responses API can return a 200 with a non-terminal status (incomplete output).
  if (json.status && json.status !== "completed") {
    const reason = json.incomplete_details?.reason ? ` reason="${json.incomplete_details.reason}"` : "";
    throw new Error(`responses status="${json.status}"${reason} (incomplete output)`);
  }
  return {
    text: extractResponsesText(json),
    usage: {
      promptTokens: json.usage?.input_tokens ?? 0,
      completionTokens: json.usage?.output_tokens ?? 0,
      totalTokens: json.usage?.total_tokens ?? 0,
    },
  };
}

/**
 * Streaming Responses API: POST {base}/responses with `stream:true` and (by design) NO
 * `max_output_tokens` when maxTokens is 0 — so a long batch (the writer's 10 scenarios on a
 * reasoning model) is never truncated into `status="incomplete"`. We accumulate the
 * `response.output_text.delta` chunks into the full JSON text, then completeJSON validates it
 * with Zod exactly as for the non-streaming path. Direct port of aiassist's `_stream_scenario_writer`
 * (same event names, same no-cap body). Honors the abort signal for the per-attempt timeout.
 */
async function completeViaResponsesStream(args: ProviderCompleteArgs): Promise<RawCompletion> {
  const { system, user, model, maxTokens, temperature, topP, jsonSchema, signal } = args;
  if (!config.OPENAI_API_KEY) {
    throw new Error("LLM_PROVIDER=openai but OPENAI_API_KEY is not set");
  }
  const base = (config.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = `${base}/responses`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.OPENAI_AUTH_STYLE === "api-key") headers["api-key"] = config.OPENAI_API_KEY;
  else headers["Authorization"] = `Bearer ${config.OPENAI_API_KEY}`;

  const body: Record<string, unknown> = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    // maxTokens === 0 means "no cap" → omit (aiassist's streaming writer sends none).
    ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { top_p: topP } : {}),
    ...(jsonSchema
      ? { text: { format: { type: "json_schema", name: jsonSchema.name, strict: jsonSchema.strict ?? true, schema: jsonSchema.schema } } }
      : {}),
    stream: true,
  };

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const preview = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`${res.status} ${res.statusText}${preview ? ` - ${preview}` : ""}`.trim());
  }

  // Parse the SSE stream line-by-line. OpenAI emits one JSON object per `data:` line; we read
  // its `type` to route. We accumulate text deltas and capture usage from the terminal event.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  const handleEvent = (dataStr: string): boolean => {
    if (dataStr === "[DONE]") return true; // sentinel → stop
    let event: any;
    try {
      event = JSON.parse(dataStr);
    } catch {
      return false; // ignore non-JSON keepalives/comments
    }
    const type: string = event?.type ?? "";
    if (type === "response.output_text.delta") {
      if (typeof event.delta === "string") text += event.delta;
    } else if (type === "response.failed" || type === "response.incomplete") {
      const payload = event.response ?? event;
      const reason = payload?.incomplete_details?.reason ? ` reason="${payload.incomplete_details.reason}"` : "";
      throw new Error(`responses stream status="${payload?.status ?? type}"${reason} (incomplete output)`);
    } else if (type === "response.completed") {
      const payload: ResponsesResult = event.response ?? {};
      if (payload.status && payload.status !== "completed") {
        const reason = payload.incomplete_details?.reason ? ` reason="${payload.incomplete_details.reason}"` : "";
        throw new Error(`responses stream status="${payload.status}"${reason} (incomplete output)`);
      }
      // Prefer the accumulated deltas; fall back to the terminal payload's text.
      if (!text) text = extractResponsesText(payload);
      usage = {
        promptTokens: payload.usage?.input_tokens ?? 0,
        completionTokens: payload.usage?.output_tokens ?? 0,
        totalTokens: payload.usage?.total_tokens ?? 0,
      };
    }
    return false;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue; // skip `event:` lines, comments, blanks
      if (handleEvent(line.slice(5).trim())) {
        await reader.cancel().catch(() => {});
        return { text, usage };
      }
    }
  }

  return { text, usage };
}

/**
 * OpenAI-compatible adapter. Speaks either Chat Completions (default) or the Responses
 * API, selected by OPENAI_API_MODE; auth header (Bearer vs api-key) by OPENAI_AUTH_STYLE.
 * Both are standard OpenAI APIs — defaults are vanilla-OpenAI, so a plain OpenAI key works
 * out of the box. Structured output is forced via json_schema when a schema is supplied;
 * completeJSON validates the shape against the zod schema and retries on mismatch.
 */
export const openaiProvider: LlmProvider = {
  name: "openai",
  async complete(args: ProviderCompleteArgs): Promise<RawCompletion> {
    if (config.OPENAI_API_MODE === "responses") {
      // Streaming only on the Responses path (the writer asks for it); the Chat path
      // ignores `stream` and stays non-streaming.
      return args.stream ? completeViaResponsesStream(args) : completeViaResponses(args);
    }
    return completeViaChat(args);
  },
};
