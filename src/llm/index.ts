import { config } from "../config.js";
import { costForTokens } from "../evals/pricing.js";
import { retryAfterMsFromError } from "./retry-after.js";
import { addUsage, emptyUsage } from "./usage.js";
import type {
  CompleteJSONOptions,
  LlmProvider,
  LlmResult,
  LlmRole,
  LlmUsage,
} from "./types.js";
import { LlmError } from "./types.js";

export type { LlmProvider, LlmResult, LlmUsage, LlmRole, CompleteJSONOptions, WireReasoningEffort } from "./types.js";
export { LlmError } from "./types.js";
export { MockLLM } from "./mock.js";

const DEFAULT_MAX_TOKENS = 4096;

// Provider default models when no per-role / explicit model is configured.
// claude-opus-4-8 is the current most-capable Anthropic model; gpt-4.1-mini
// matches the Python SDK judges' fallback (plugins/agent-observability-sdk).
//
// These are a LAST RESORT, and on a gateway deployment they are the wrong answer:
// only the judge role can reach them (generation and the simulator always pass an
// explicit model), and an Azure/Vibe deployment does not host a deployment named
// "gpt-4.1-mini", so an unset JUDGE_MODEL turns every judge call into a
// DeploymentNotFound. The value is kept — it is a working default for a vanilla
// OpenAI or Anthropic key, which is the OSS path — but resolveModel() now warns
// once and names the env var to set, because the resulting provider 404 does not
// mention JUDGE_MODEL anywhere.
const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-4.1-mini",
};

/** One-shot guard so the unset-model warning doesn't repeat per judge call
 *  (a single session fans out ~13 of them). */
let warnedMissingRoleModel = false;

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
  const envVar =
    role === "simulator" ? "SIMULATOR_MODEL"
    : role === "generator" ? "GENERATOR_MODEL"
    : "JUDGE_MODEL";
  const roleModel =
    role === "simulator" ? config.SIMULATOR_MODEL
    : role === "generator" ? config.GENERATOR_MODEL
    : config.JUDGE_MODEL;
  if (roleModel) return roleModel;
  const fallback = PROVIDER_DEFAULT_MODEL[providerName] || "claude-opus-4-8";
  // Fail LOUD-ish rather than silently: the provider error this produces on a
  // gateway deployment is "DeploymentNotFound: gpt-4.1-mini", which names a model
  // the operator never configured and gives no hint that the fix is an env var.
  if (!warnedMissingRoleModel) {
    warnedMissingRoleModel = true;
    console.warn(
      `[llm] ${envVar} is not set — falling back to the ${providerName} provider default ` +
        `"${fallback}". That is correct for a vanilla ${providerName} key, but a gateway / ` +
        `Azure deployment almost certainly does not host it, in which case every ${role ?? "judge"} ` +
        `call will fail with a model-not-found error. Set ${envVar} to a deployment name your ` +
        `endpoint serves.`,
    );
  }
  return fallback;
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

/** True when the provider reported output truncated by the token cap
 *  (Responses API `status="incomplete" reason="max_output_tokens"`, thrown by
 *  both the blocking and streaming paths with this exact marker). */
function isTruncationError(e: unknown): boolean {
  return e instanceof Error && e.message.includes('reason="max_output_tokens"');
}

// Truncation-retry escalation bounds. A capped call that truncates is
// DETERMINISTIC — resending identical parameters fails identically, which is
// how whole sessions' evals were lost in prod (2026-07-14 ap-south, 2026-07-23
// both regions: invisible reasoning tokens exhausted caps sized for visible
// output). Each truncated attempt doubles the cap, bounded to 4x the caller's
// budget so a runaway model can't multiply spend without limit. Effort
// (when set above "low") drops to "low" — never adaptively to "none", which
// some deployments reject as an invalid enum value.
const TRUNCATION_CAP_MULTIPLIER_LIMIT = 4;

/** Wrap a live-text sink so a throw disables it (with one log) instead of
 *  rejecting the provider call — sinks are observational by contract. */
function guardOnText(sink?: (delta: string) => void): ((delta: string) => void) | undefined {
  if (!sink) return undefined;
  let dead = false;
  return (delta: string) => {
    if (dead) return;
    try {
      sink(delta);
    } catch (e) {
      dead = true;
      console.error(`[llm] onText sink threw — disabled for this attempt: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

const JSON_ONLY_HINT =
  "Respond with ONLY a single JSON object that satisfies the required schema. " +
  "No prose, no explanation, no markdown code fences.";

/**
 * Emit one structured accounting line per LLM call.
 *
 * completeJSON is the single chokepoint every LLM call in this service passes
 * through (planner, writer, user simulator, judges), so this is the ONE place
 * token spend has to be recorded for the accounting to be complete. Adding a
 * call site later cannot silently escape it.
 *
 * Emitted on EVERY exit — success, retries-exhausted, and caller-abort. A call
 * that failed still burned every token it sent, and dropping those would
 * under-report spend exactly when something is going wrong: a schema-retry loop
 * against a large prompt is the most expensive failure mode this service has,
 * and counting only successes would rank the model that fails most as cheapest.
 *
 * `cost_usd` is best-effort and prints `unknown` when we hold no rate for the
 * model. Never a fabricated 0: a zero silently understates a bill and reads as
 * "this was free", whereas `unknown` is a visible prompt to add the price row.
 */
function logUsage(a: {
  label?: string;
  role?: LlmRole;
  correlationId?: string;
  model: string;
  provider: string;
  usage: LlmUsage;
  attempts: number;
  startedAt: number;
  outcome: "ok" | "error" | "aborted";
}): void {
  // Shared with the per-session walk in evals/metrics.ts — one formula, so the two
  // cannot report different dollars for the same tokens.
  //
  // reasoningTokens is deliberately NOT passed: it is a SUBSET of completionTokens
  // (the provider counts invisible reasoning inside output_tokens and bills it at
  // the output rate), so it is already paid for. It is logged separately purely as
  // a truncation-pressure signal.
  //
  // cachedPromptTokens is likewise not passed — not because caching is ignored, but
  // because LlmUsage does not carry it yet (see providers/openai.ts:
  // `prompt_tokens_details.cached_tokens` is available and unread). Until it does,
  // this over-estimates input cost when prompt caching is active. The formula
  // itself handles caching correctly the moment the field arrives.
  const cost = costForTokens(a.provider, a.model, {
    promptTokens: a.usage.promptTokens,
    completionTokens: a.usage.completionTokens,
  });
  console.log(
    `[llm] usage label=${a.label ?? a.role ?? "unknown"} role=${a.role ?? "-"} ` +
      `model=${a.model} provider=${a.provider} ` +
      `correlation_id=${a.correlationId ?? "-"} ` +
      `prompt_tokens=${a.usage.promptTokens} completion_tokens=${a.usage.completionTokens} ` +
      `reasoning_tokens=${a.usage.reasoningTokens ?? 0} total_tokens=${a.usage.totalTokens} ` +
      `attempts=${a.attempts} duration_ms=${Date.now() - a.startedAt} ` +
      `cost_usd=${cost === null ? "unknown" : cost.toFixed(6)} outcome=${a.outcome}`,
  );
}

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
  // undefined → the default cap; explicit null → 0, which the provider reads as
  // "omit max_output_tokens" (no cap — used by the streaming writer).
  const maxTokens = opts.maxTokens === undefined ? DEFAULT_MAX_TOKENS : (opts.maxTokens ?? 0);
  const timeoutMs = opts.timeoutMs ?? config.LLM_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? config.LLM_MAX_RETRIES;

  // noJsonHint sends `system` verbatim (the simulator passes the bare template, mirroring cx-sqs
  // which relies on strict json_schema alone). Otherwise append the JSON-only instruction.
  const system = opts.noJsonHint
    ? (opts.system ?? "")
    : opts.system
      ? `${opts.system}\n\n${JSON_ONLY_HINT}`
      : JSON_ONLY_HINT;
  let user = opts.prompt;

  const usage: LlmUsage = emptyUsage();
  // Wall clock for the whole call INCLUDING retries and their backoff — the number
  // that matches what the caller actually waited, not just the last attempt.
  const startedAt = Date.now();
  const account = (attempts: number, outcome: "ok" | "error" | "aborted"): void =>
    logUsage({
      label: opts.label,
      role: opts.role,
      correlationId: opts.correlationId,
      model,
      provider: provider.name,
      usage,
      attempts,
      startedAt,
      outcome,
    });
  /**
   * An attempt the model ANSWERED but we refused — unparseable JSON, or JSON that failed
   * the Zod schema.
   *
   * A transport failure has always logged; a rejection never did. It set `lastError`,
   * re-prompted, and moved on in silence, which made the most expensive failure mode in
   * the service its least visible one: the model is paid for every rejected attempt, and
   * a caller with its own retry loop on top (the generation planner replans) can burn
   * minutes without a single line saying why.
   *
   * Concretely, 2026-08-05: a smoke-mode planner call spent 56s on two rejected attempts
   * and triggered a 28s replan — 84s against the same flow's 25s in stress mode — and the
   * only trace anywhere was `outcome=error` on the usage line. Nothing named the failing
   * field, so the failure could be seen but not fixed.
   *
   * Shares `account()`'s captured context deliberately: the model, label and attempt
   * budget are the same facts, and passing them positionally instead invited transposing
   * two adjacent strings into a silently wrong line. `reason` is the detail already
   * computed for the re-prompt, so this costs nothing beyond the write.
   */
  const reject = (attempt: number, kind: "schema" | "invalid JSON", reason: string): void => {
    console.warn(
      `[llm] attempt ${attempt}/${maxRetries + 1} rejected ` +
        `(model=${model} label=${opts.label ?? opts.role ?? "-"}): ${kind} — ${reason}`,
    );
  };
  let lastError: unknown;
  // Per-attempt request shape, escalated on truncation (see isTruncationError):
  // a truncated call MUST NOT be retried verbatim — it fails identically.
  let attemptMaxTokens = maxTokens;
  let attemptEffort = opts.reasoningEffort;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    // Caller abort (client disconnected): stop immediately — no retry, no backoff.
    if (opts.signal?.aborted) {
      // An abort reached here AFTER a completed attempt still burned that attempt's
      // tokens — the SSE client disconnecting mid-generation is the common case, and
      // that spend is invisible today. Account for it, but only when something was
      // actually spent: a request aborted before its first call must not emit an
      // all-zero line into the accounting stream.
      if (usage.totalTokens > 0) account(attempt - 1, "aborted");
      throw new LlmError("completeJSON aborted by caller", opts.signal.reason);
    }
    // Back off before a retry so a transient rate-limit (429) / timeout isn't hit
    // again immediately. Skipped on the first attempt. This matters under simulation
    // concurrency (many simulator calls hit the LLM at once).
    //
    // A server-supplied `Retry-After` WINS over the exponential guess: on a TPM
    // exhaustion the whole minute's allowance is already gone, so 400ms/800ms just
    // burns the remaining attempts inside the same closed window — observed on dev
    // 2026-08-05, where 182 429s decayed only 63 -> 60 -> 58 across three attempts.
    // The hint is capped at RETRY_AFTER_CAP_MS by the parser, so a hostile or
    // mistaken value cannot outlast the per-attempt timeout.
    if (attempt > 1) {
      const hinted = retryAfterMsFromError(lastError);
      await Bun.sleep(hinted ?? Math.min(4000, 400 * 2 ** (attempt - 2)));
    }
    let raw: { text: string; usage: LlmUsage };
    try {
      raw = await provider.complete({
        system,
        user,
        model,
        maxTokens: attemptMaxTokens,
        temperature: opts.temperature,
        topP: opts.topP,
        reasoningEffort: attemptEffort,
        jsonSchema: opts.jsonSchema,
        stream: opts.stream,
        apiMode: opts.apiMode,
        // Fresh sink per attempt: each retry is a new stream, so incremental
        // consumers get a reset (see CompleteJSONOptions.makeOnText). The shim
        // ENFORCES the sinks-must-not-throw contract: a throwing sink would
        // otherwise reject the provider call and burn full LLM retries on a
        // deterministic consumer bug — instead it's disabled for the attempt.
        onText: guardOnText(opts.makeOnText?.(attempt)),
        // Per-attempt timeout, raced with the caller's abort when one is supplied.
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Network error / timeout / non-2xx (e.g. a 404 from a misconfigured LLM endpoint).
      // Log it on AO's own stdout so failures are visible here, not only in the caller that
      // re-raises the streamed error. No secret/api-key is in the message; the prompt is omitted.
      lastError = e;
      console.error(
        `[llm] ${provider.name} attempt ${attempt}/${maxRetries + 1} failed (model=${model}): ` +
          (e instanceof Error ? e.message : String(e)),
      );
      // Truncation is deterministic for a fixed request — escalate before the
      // next attempt instead of resending byte-identical parameters: double the
      // cap (bounded) and drop reasoning effort above "low" down to "low".
      // Transient failures (429/timeout/5xx) keep the original shape.
      if (isTruncationError(e) && attemptMaxTokens > 0) {
        const nextMaxTokens = Math.min(attemptMaxTokens * 2, maxTokens * TRUNCATION_CAP_MULTIPLIER_LIMIT);
        const nextEffort = attemptEffort === "medium" || attemptEffort === "high" ? "low" : attemptEffort;
        if (nextMaxTokens !== attemptMaxTokens || nextEffort !== attemptEffort) {
          console.warn(
            `[llm] truncated at max_output_tokens (model=${model}) — escalating retry: ` +
              `maxTokens ${attemptMaxTokens}→${nextMaxTokens}` +
              (nextEffort !== attemptEffort ? `, reasoningEffort ${attemptEffort}→${nextEffort}` : ""),
          );
          attemptMaxTokens = nextMaxTokens;
          attemptEffort = nextEffort;
        }
      }
      continue;
    }
    addUsage(usage, raw.usage);
    // Reasoning-pressure breadcrumb: invisible reasoning spend at ≥50% of the cap
    // means the next model/deployment shift can tip this call into truncation —
    // surface it while the call still succeeds, not after evals start dying.
    if (attemptMaxTokens > 0 && (raw.usage.reasoningTokens ?? 0) >= attemptMaxTokens / 2) {
      console.warn(
        `[llm] reasoning tokens at ${raw.usage.reasoningTokens}/${attemptMaxTokens} cap (model=${model}) — ` +
          `truncation pressure; check reasoningEffort vs the cap`,
      );
    }

    const parsed = tryParseJson(raw.text);
    if (!parsed.ok) {
      lastError = new Error(`invalid JSON: ${parsed.error}`);
      reject(attempt, "invalid JSON", parsed.error);
      user = `${opts.prompt}\n\nYour previous response was not valid JSON (${parsed.error}). Return a single JSON object only.`;
      continue;
    }

    const result = opts.schema.safeParse(parsed.value);
    if (result.success) {
      account(attempt, "ok");
      return { data: result.data, usage, raw: raw.text, attempts: attempt };
    }
    lastError = result.error;
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    reject(attempt, "schema", issues);
    user = `${opts.prompt}\n\nYour previous response failed schema validation: ${issues}. Return corrected JSON only.`;
  }

  // Account for the spend BEFORE throwing: every attempt above sent a full prompt
  // and was billed for it. Omitting failed calls would make the cheapest-looking
  // model the one that fails most.
  account(maxRetries + 1, "error");
  // Surface the underlying cause (429 / timeout / validation) in the message so a
  // failed simulation result says WHY, not just "failed".
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new LlmError(`completeJSON failed after ${maxRetries + 1} attempt(s): ${detail}`, lastError, usage);
}
