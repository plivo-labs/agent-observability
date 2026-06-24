import OpenAI from "openai";
import { config } from "../../config.js";
import type { LlmProvider, ProviderCompleteArgs, RawCompletion } from "../types.js";

let client: OpenAI | undefined;

function getClient(): OpenAI {
  if (!config.OPENAI_API_KEY) {
    throw new Error("LLM_PROVIDER=openai but OPENAI_API_KEY is not set");
  }
  if (!client) {
    // OPENAI_BASE_URL covers Azure OpenAI / OpenRouter / a local server.
    client = new OpenAI({ apiKey: config.OPENAI_API_KEY, baseURL: config.OPENAI_BASE_URL || undefined });
  }
  return client;
}

/**
 * OpenAI-compatible adapter. Uses JSON mode (`response_format: json_object`),
 * which forces syntactically valid JSON; completeJSON validates the shape
 * against the zod schema and retries on mismatch. The system prompt contains
 * the word "JSON" (required by json_object mode).
 */
export const openaiProvider: LlmProvider = {
  name: "openai",
  async complete({ system, user, model, maxTokens, temperature, topP, jsonSchema, signal }: ProviderCompleteArgs): Promise<RawCompletion> {
    // Strict json_schema when a schema is supplied (guarantees required fields);
    // otherwise the looser json_object (valid-JSON-only) mode.
    const response_format = jsonSchema
      ? ({ type: "json_schema", json_schema: { name: jsonSchema.name, strict: true, schema: jsonSchema.schema } } as const)
      : ({ type: "json_object" } as const);
    const res = await getClient().chat.completions.create(
      {
        model,
        max_tokens: maxTokens,
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
  },
};
