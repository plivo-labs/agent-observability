import type { ZodType } from "zod";

/**
 * The reasoning-effort values a provider actually accepts on the wire.
 *
 * Deliberately does NOT include the `"inherit"` config sentinel: that is collapsed to
 * `undefined` in the env schema (see `reasoningEffort()` in src/schema.ts), so by the time an
 * effort reaches this layer it is either a real provider value or absent. Callers therefore
 * cannot ship `"inherit"` to a provider — it is unrepresentable here.
 */
export type WireReasoningEffort = "none" | "low" | "medium" | "high";

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
  /** Invisible reasoning tokens (Responses API `output_tokens_details.reasoning_tokens`).
   *  They bill against the same `max_output_tokens` budget as visible output, so this is
   *  the number that explains a truncation the visible output alone can't. Absent when
   *  the provider doesn't report it (Chat path, Anthropic, mock). */
  reasoningTokens?: number;
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
   * Reasoning effort for reasoning models (gpt-5.x). Undefined => omit the
   * parameter and inherit the model's own default. The reference engine pins
   * "none" (cx-sqs-worker config/env.ctmpl:92), which is what makes its 1500-5000
   * output caps sufficient: at effort "none" almost none of max_output_tokens is
   * spent on invisible reasoning tokens.
   *
   * Honored on BOTH OpenAI paths, with different wire shapes the provider handles:
   * Responses sends nested `reasoning: {effort}`, Chat Completions sends a flat
   * `reasoning_effort`. Anthropic ignores it (thinking is deliberately off there —
   * see providers/anthropic.ts).
   */
  reasoningEffort?: WireReasoningEffort;
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
  /**
   * Optional live text sink: called with each output-text delta as it arrives on
   * a streaming call. Purely observational — the provider still returns the full
   * accumulated text, and paths without text deltas (non-streaming; the Anthropic
   * tool-forced path, whose JSON arrives as tool input) simply never call it.
   * Sinks must not throw.
   */
  onText?: (delta: string) => void;
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
  /** Reasoning effort for reasoning models; see ProviderCompleteArgs.reasoningEffort. */
  reasoningEffort?: WireReasoningEffort;
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
  /**
   * Factory for a per-attempt live text sink. completeJSON retries internally
   * (re-prompting on parse/schema failures), and each attempt is a fresh stream —
   * so the factory is invoked at the START of every attempt and the returned sink
   * receives only THAT attempt's deltas. Consumers that parse the stream
   * incrementally (the writer's scenario extractor) reset their state here.
   */
  makeOnText?: (attempt: number) => (delta: string) => void;
  /** Caller-supplied abort (e.g. the SSE client disconnected). Combined with the per-attempt
   *  timeout; an abort stops retries immediately so abandoned requests stop burning LLM spend. */
  signal?: AbortSignal;
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
