import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config.js";
import type { LlmProvider, ProviderCompleteArgs, RawCompletion } from "../types.js";

let client: Anthropic | undefined;

// Anthropic's API REQUIRES a positive max_tokens — there is no "unlimited". When a caller
// asks for "no cap" (maxTokens === 0, e.g. the streaming writer that omits the cap on the
// OpenAI path), substitute a generous ceiling big enough for a large structured batch. The
// default model (claude-opus-4-8) supports this; OSS users on a smaller Claude can lower it.
const NO_CAP_MAX_TOKENS = 32000;

function getClient(): Anthropic {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set");
  }
  if (!client) client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return client;
}

/**
 * Anthropic adapter (Claude). Thinking is intentionally left off — judge/sim calls return
 * small structured verdicts where the extra latency/cost isn't worth it.
 *
 * Structured output: when the caller passes `jsonSchema`, it is enforced via FORCED tool
 * use (one tool whose input_schema is the caller's schema + tool_choice) — the Anthropic
 * equivalent of OpenAI's strict json_schema. Every judge and the writer rely on that
 * guarantee; carrying it only in the system prompt made "wrong shape but valid JSON"
 * replies possible. Without `jsonSchema` the JSON-only contract stays prompt-carried and
 * completeJSON's Zod retry loop is the enforcement.
 *
 * Streaming: `stream:true` uses the SDK's streaming client (accumulated via finalMessage)
 * so long no-cap writer batches aren't subject to the non-streaming HTTP timeout. Both
 * paths converge on the same final Message extraction.
 */
export const anthropicProvider: LlmProvider = {
  name: "anthropic",
  async complete({ system, user, model, maxTokens, temperature, topP, jsonSchema, stream, signal, onText }: ProviderCompleteArgs): Promise<RawCompletion> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      // maxTokens === 0 means "no cap" — Anthropic needs a positive number, so use the ceiling.
      max_tokens: maxTokens || NO_CAP_MAX_TOKENS,
      system,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { top_p: topP } : {}),
      ...(jsonSchema
        ? {
            tools: [
              {
                name: jsonSchema.name,
                description: "Return the result in the required schema.",
                input_schema: jsonSchema.schema as Anthropic.Tool.InputSchema,
              },
            ],
            tool_choice: { type: "tool" as const, name: jsonSchema.name },
          }
        : {}),
      messages: [{ role: "user", content: user }],
    };

    let res: Anthropic.Message;
    if (stream) {
      const s = getClient().messages.stream(params, { signal });
      // Live text sink (text deltas only). The tool-forced path streams its JSON as
      // tool INPUT deltas, not text — onText never fires there, so incremental
      // consumers automatically fall back to the authoritative final parse.
      if (onText) s.on("text", (delta) => onText(delta));
      res = await s.finalMessage();
    } else {
      res = await getClient().messages.create(params, { signal });
    }

    // Forced tool use → the result is the tool_use block's input; otherwise concatenated text.
    // Either way the return is a JSON string for completeJSON's parse+Zod validation.
    const toolBlock = jsonSchema
      ? res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === jsonSchema.name)
      : undefined;
    const text = toolBlock
      ? JSON.stringify(toolBlock.input)
      : res.content
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
