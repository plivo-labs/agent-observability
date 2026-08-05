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
   * parameter and inherit the model's own default.
   *
   * Honored on BOTH OpenAI paths, with different wire shapes the provider handles:
   * Responses sends nested `reasoning: {effort}`, Chat Completions sends a flat
   * `reasoning_effort`. Anthropic ignores it (thinking is deliberately off there —
   * see providers/anthropic.ts).
   *
   * REFERENCE PARITY, precisely — the global pin and the per-path behaviour differ,
   * and conflating them sends you looking for a bug that isn't there:
   *
   *   cx-sqs pins DefaultReasoningEffort="none" (config/env.ctmpl:92), and its
   *   RESPONSES builder applies it (`body["reasoning"] = {effort}`) — which is what
   *   makes its 1500-5000 output caps sufficient, since at "none" almost none of
   *   max_output_tokens goes to invisible reasoning. But its CHAT builder
   *   (buildChatCompletionsBody) has no reasoning key at ALL, so on that transport
   *   the pin is unreachable and the deployment default applies.
   *
   * Consequence: AO forwarding effort on the Chat path is a deliberate EXTENSION of
   * the reference, not parity with it. The one caller pinned to Chat is the user
   * simulator, so its default must stay "omit" to match — see
   * SIM_USER_REASONING_EFFORT in schema.ts and the invariant test in
   * tests/sim-engine-config.test.ts.
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
  /**
   * Operation name for the `[llm] usage` accounting line. `role` is too coarse to
   * bill against — the planner and the writer are BOTH "generator", and they have
   * very different token profiles, so a per-role total can't tell you which half of
   * generation a cost regression came from.
   *
   * Keep the cardinality low and stable (it is a log field that gets grouped on):
   * "planner", "writer", "user_sim", "eval_hallucination", …
   */
  label?: string;
  /**
   * Opaque id tying this call to the unit of work that caused it — a generation id
   * or a scenario id. Purely observational: it is never sent to the provider, only
   * printed on the usage line, so the per-call token spend of a 30-scenario
   * generation or a 7-turn simulation can be summed by grouping on one field.
   *
   * This is what makes per-call logging sufficient on its own, and is the reason
   * roll-up totals don't have to be threaded back up through every return type.
   */
  correlationId?: string;
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
  /**
   * Tokens the failed call actually burned, summed across its attempts.
   *
   * A call that exhausts its retries was still billed for every attempt, and the
   * caller is the only layer that can attribute that spend to the work that caused it
   * — by the time this throws, `completeJSON` has already emitted its per-call
   * accounting line, but a caller with its own retry loop on top (the generation
   * planner replans) would otherwise report only the attempt that eventually
   * succeeded. Carrying usage on the error is what lets a roll-up stay honest.
   */
  readonly usage?: LlmUsage;
  constructor(message: string, cause?: unknown, usage?: LlmUsage) {
    super(message);
    this.name = "LlmError";
    this.cause = cause;
    this.usage = usage;
  }
}
