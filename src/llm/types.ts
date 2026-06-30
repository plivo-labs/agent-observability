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
  /** Output token cap. `0` means "omit the cap" — let the model emit until done
   *  (used by the streaming writer so a long batch isn't truncated). */
  maxTokens: number;
  /**
   * Stream the response (Responses API SSE) instead of one blocking call. Lets
   * the model emit an arbitrarily long result without a `max_output_tokens` cap,
   * so a big batch never returns `status="incomplete"`. Honored only on the
   * Responses path; the Chat path ignores it (stays non-streaming).
   */
  stream?: boolean;
  /** Sampling temperature; provider default when undefined. */
  temperature?: number;
  /** Nucleus sampling top_p; provider default when undefined. */
  topP?: number;
  /**
   * Strict JSON-schema for structured output (OpenAI/Azure). When set, the
   * provider forces the response to match this schema exactly — guarantees the
   * required fields instead of the looser json_object "valid JSON" contract.
   */
  jsonSchema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
  /**
   * Override the wire API for THIS call: "chat" (Chat Completions) or "responses"
   * (Responses API). Defaults to OPENAI_API_MODE when undefined. The user-simulator
   * forces "chat" to mirror the reference (cx-sqs) caller; generation stays on the
   * global mode (Responses, required by its reasoning model).
   */
  apiMode?: "chat" | "responses";
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
  /** Output token cap. Omit for the default; pass `null` for "no cap" (the
   *  streaming writer uses this so a large batch isn't truncated). */
  maxTokens?: number | null;
  /** Stream the provider call (Responses API SSE). See ProviderCompleteArgs.stream. */
  stream?: boolean;
  /** Sampling temperature (e.g. the user simulator runs hot at 0.85). */
  temperature?: number;
  /** Nucleus sampling top_p. */
  topP?: number;
  /** Strict JSON-schema for structured output — guarantees required fields (OpenAI/Azure). */
  jsonSchema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
  /** Override the wire API for this call ("chat" | "responses"); defaults to OPENAI_API_MODE. */
  apiMode?: "chat" | "responses";
  /** Skip the appended JSON_ONLY_HINT and send `system` verbatim. The simulator uses this so the
   *  system prompt is the bare template (matches cx-sqs, which relies on strict json_schema alone). */
  noJsonHint?: boolean;
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
