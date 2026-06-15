import { config } from "../config.js";
import type {
  CompleteJSONOptions,
  LlmProvider,
  LlmResult,
  LlmRole,
  LlmUsage,
} from "./types.js";
import { LlmError } from "./types.js";

export type { LlmProvider, LlmResult, LlmUsage, LlmRole, CompleteJSONOptions } from "./types.js";
export { LlmError } from "./types.js";
export { MockLLM } from "./mock.js";

const DEFAULT_MAX_TOKENS = 4096;

// Provider default models when no per-role / explicit model is configured.
// claude-opus-4-8 is the current most-capable Anthropic model; gpt-4.1-mini
// matches the Python SDK judges' fallback. Override per role via env.
const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-4.1-mini",
};

// Lazily import the provider SDK only for the configured provider, so unit
// tests (which inject MockLLM) never load @anthropic-ai/sdk or openai.
async function resolveProvider(): Promise<LlmProvider> {
  if (config.LLM_PROVIDER === "openai") {
    return (await import("./providers/openai.js")).openaiProvider;
  }
  return (await import("./providers/anthropic.js")).anthropicProvider;
}

function resolveModel(role: LlmRole | undefined, explicit: string | undefined, providerName: string): string {
  if (explicit) return explicit;
  const roleModel =
    role === "simulator" ? config.SIMULATOR_MODEL
    : role === "generator" ? config.GENERATOR_MODEL
    : config.JUDGE_MODEL;
  return roleModel || PROVIDER_DEFAULT_MODEL[providerName] || "claude-opus-4-8";
}

/** Strip markdown code fences and parse. Models sometimes wrap JSON in ```. */
function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function addUsage(into: LlmUsage, from: LlmUsage): void {
  into.promptTokens += from.promptTokens;
  into.completionTokens += from.completionTokens;
  into.totalTokens += from.totalTokens;
}

const JSON_ONLY_HINT =
  "Respond with ONLY a single JSON object that satisfies the required schema. " +
  "No prose, no explanation, no markdown code fences.";

/**
 * Provider-neutral structured LLM call. Sends the prompt, parses the response
 * as JSON, validates it against `schema`, and on a parse/validation failure
 * re-prompts (up to `maxRetries`) with the specific error appended. Times each
 * attempt out via AbortSignal and accumulates token usage across attempts.
 *
 * Providers are thin (return raw text); this function is the single place the
 * validate/retry/timeout/usage logic lives, so it can be exhaustively tested
 * against MockLLM without any network or API key.
 */
export async function completeJSON<T>(opts: CompleteJSONOptions<T>): Promise<LlmResult<T>> {
  const provider = opts.provider ?? (await resolveProvider());
  const model = resolveModel(opts.role, opts.model, provider.name);
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = opts.timeoutMs ?? config.LLM_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? config.LLM_MAX_RETRIES;

  const system = opts.system ? `${opts.system}\n\n${JSON_ONLY_HINT}` : JSON_ONLY_HINT;
  let user = opts.prompt;

  const usage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    let raw: { text: string; usage: LlmUsage };
    try {
      raw = await provider.complete({ system, user, model, maxTokens, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      // Network error / timeout — retry while attempts remain, otherwise fail.
      lastError = e;
      continue;
    }
    addUsage(usage, raw.usage);

    const parsed = tryParseJson(raw.text);
    if (!parsed.ok) {
      lastError = new Error(`invalid JSON: ${parsed.error}`);
      user = `${opts.prompt}\n\nYour previous response was not valid JSON (${parsed.error}). Return a single JSON object only.`;
      continue;
    }

    const result = opts.schema.safeParse(parsed.value);
    if (result.success) {
      return { data: result.data, usage, raw: raw.text, attempts: attempt };
    }
    lastError = result.error;
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    user = `${opts.prompt}\n\nYour previous response failed schema validation: ${issues}. Return corrected JSON only.`;
  }

  throw new LlmError(`completeJSON failed after ${maxRetries + 1} attempt(s)`, lastError);
}
