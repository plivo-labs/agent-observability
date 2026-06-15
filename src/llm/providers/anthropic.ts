import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config.js";
import type { LlmProvider, ProviderCompleteArgs, RawCompletion } from "../types.js";

let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set");
  }
  if (!client) client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return client;
}

/**
 * Anthropic adapter (Claude). Returns raw text; completeJSON enforces the JSON
 * schema. Thinking is intentionally left off — judge/sim calls return small
 * structured verdicts where the extra latency/cost isn't worth it. The
 * JSON-only contract is carried by the system prompt (see completeJSON).
 */
export const anthropicProvider: LlmProvider = {
  name: "anthropic",
  async complete({ system, user, model, maxTokens, signal }: ProviderCompleteArgs): Promise<RawCompletion> {
    const res = await getClient().messages.create(
      {
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      },
      { signal },
    );

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      text,
      usage: {
        promptTokens: res.usage.input_tokens ?? 0,
        completionTokens: res.usage.output_tokens ?? 0,
        totalTokens: (res.usage.input_tokens ?? 0) + (res.usage.output_tokens ?? 0),
      },
    };
  },
};
