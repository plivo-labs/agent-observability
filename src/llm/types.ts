import type { ZodType } from "zod";

/**
 * Per-role model selection. The eval engine, simulator, and scenario generator
 * each pick their model independently (JUDGE_MODEL / SIMULATOR_MODEL /
 * GENERATOR_MODEL), falling back to the provider default when unset.
 */
export type LlmRole = "judge" | "simulator" | "generator";

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** One raw provider call: system + user prompt in, JSON-ish text + usage out. */
export interface RawCompletion {
  text: string;
  usage: LlmUsage;
}

export interface ProviderCompleteArgs {
  system: string;
  user: string;
  model: string;
  maxTokens: number;
  /** Sampling temperature; provider default when undefined. */
  temperature?: number;
  /** Nucleus sampling top_p; provider default when undefined. */
  topP?: number;
  /**
   * Strict JSON-schema for structured output (OpenAI/Azure). When set, the
   * provider forces the response to match this schema exactly — guarantees the
   * required fields instead of the looser json_object "valid JSON" contract.
   */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Aborts the call when the completeJSON timeout fires. */
  signal: AbortSignal;
}

/**
 * A provider is intentionally thin: it returns raw text + token usage and does
 * NOT validate the schema. All schema validation, retry, and timeout handling
 * live in completeJSON, so providers stay simple and the hard logic is tested
 * once against MockLLM rather than per-provider.
 */
export interface LlmProvider {
  readonly name: string;
  complete(args: ProviderCompleteArgs): Promise<RawCompletion>;
}

export interface CompleteJSONOptions<T> {
  /** Zod schema the returned object must satisfy. */
  schema: ZodType<T>;
  /** The data/content to act on (user turn). */
  prompt: string;
  /** Natural-language instructions (system turn). */
  system?: string;
  /** Role drives default model selection when `model` is not given. */
  role?: LlmRole;
  /** Explicit model id; overrides role-based selection. */
  model?: string;
  maxTokens?: number;
  /** Sampling temperature (e.g. the user simulator runs hot at 0.85). */
  temperature?: number;
  /** Nucleus sampling top_p. */
  topP?: number;
  /** Strict JSON-schema for structured output — guarantees required fields (OpenAI/Azure). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  timeoutMs?: number;
  /** Reprompt attempts after the first call (default from config). */
  maxRetries?: number;
  /** Inject a provider (tests pass MockLLM; prod resolves from env). */
  provider?: LlmProvider;
}

export interface LlmResult<T> {
  data: T;
  /** Token usage summed across every attempt (retries included). */
  usage: LlmUsage;
  /** Raw text of the final (successful) completion. */
  raw: string;
  /** 1-based count of provider calls made. */
  attempts: number;
}

export class LlmError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "LlmError";
    this.cause = cause;
  }
}
