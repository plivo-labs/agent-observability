// Compute per-case and per-run metrics (latency, token usage, cost)
// from the events the plugin already sends. Pure synchronous function
// — pricing data must be loaded into pricing.ts before this is called
// (callers `await ensurePricesLoaded()` once, then run any number of
// `computeCaseMetrics()` calls without await).
//
// Event shape (per plugins/pytest-agent-observability/.../events.py):
//   { type: 'message', role: 'assistant', interrupted: bool,
//     metrics: { llm_node_ttft, tts_node_ttfb, llm_prompt_tokens,
//                llm_completion_tokens, llm_total_tokens,
//                llm_cache_read_tokens, llm_metadata: {
//                  model_provider, model_name }, ... } }
//   { type: 'function_call', ... }
//   { type: 'agent_handoff', ... }
//   { type: 'usage', ... }     // standalone usage events (some SDKs)
//
// Token sources are intentionally permissive: we accept several
// upstream-key variants (snake/camel, OpenAI vs Anthropic naming) so
// the server-side computation is robust against differently-shaped
// plugins. Provider/model identifiers fall back from top-level →
// nested `llm_metadata`.
//
// Cost: per-sample lookup via priceFor() with cache_read split.
// Returns null when any sample with tokens couldn't be priced
// (conservative — don't show a partial sum as if it were complete).

import { priceFor } from "./pricing.js";

// LiveKit emits per-turn timing in seconds. We store milliseconds.
const TTFT_KEYS = ["llm_node_ttft", "llmNodeTtft"];
const TTFB_KEYS = ["tts_node_ttfb", "ttsNodeTtfb"];

// Token-count keys. Multiple variants so we don't miss tokens shipped
// under provider-specific or SDK-specific names.
const PROMPT_TOKEN_KEYS = [
  "llm_prompt_tokens", "llmPromptTokens",
  "prompt_tokens", "promptTokens",
  "input_tokens", "inputTokens",
];
const COMPLETION_TOKEN_KEYS = [
  "llm_completion_tokens", "llmCompletionTokens",
  "completion_tokens", "completionTokens",
  "output_tokens", "outputTokens",
];
const TOTAL_TOKEN_KEYS = [
  "llm_total_tokens", "llmTotalTokens",
  "total_tokens", "totalTokens",
];
const CACHED_TOKEN_KEYS = [
  "cached_prompt_tokens", "cachedPromptTokens",
  "cache_read_input_tokens", "cacheReadInputTokens",
  "cached_tokens", "cachedTokens",
  "llm_cache_read_tokens", "llmCacheReadTokens",
];

// Provider/model identifier keys, at the top level of the event /
// metrics record.
const PROVIDER_KEYS = ["model_provider", "modelProvider", "provider"];
const MODEL_KEYS = ["model_name", "modelName", "model"];

export interface CaseMetrics {
  // Latency (milliseconds)
  ttft_p50_ms: number | null;
  ttft_p95_ms: number | null;
  ttft_avg_ms: number | null;
  ttfb_p50_ms: number | null;
  ttfb_p95_ms: number | null;
  ttfb_avg_ms: number | null;
  // Counters
  turn_count: number;
  tool_call_count: number;
  interruption_count: number;
  agent_handoff_count: number;
  ttft_sample_count: number;
  // Token usage (sums across all in-scope events with usage data)
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_prompt_tokens: number;
  // Estimated USD cost. Null when at least one sample has tokens but
  // its provider:model isn't priced (conservative: don't surface a
  // partial cost as if it were the full picture).
  estimated_cost_usd: number | null;
}

interface UsageSample {
  provider: string | null;
  model: string | null;
  prompt_tokens: number;
  cached_prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Walk an events array (one case's events, or a flat-mapped list
 * across all cases of a run) and produce latency + usage + cost
 * metrics. Latency percentile fields return null when no samples.
 * Counter and token fields always return a number (zero baseline).
 * Cost returns null when at least one usage sample couldn't be priced. */
export function computeCaseMetrics(events: unknown[]): CaseMetrics {
  const ttftMs: number[] = [];
  const ttfbMs: number[] = [];
  const usageSamples: UsageSample[] = [];
  let turnCount = 0;
  let toolCallCount = 0;
  let interruptionCount = 0;
  let agentHandoffCount = 0;

  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const ev = raw as Record<string, unknown>;
    const type = ev.type;

    if (type === "message") {
      // Turn = one assistant message. User messages and other roles
      // don't count as agent turns.
      if (ev.role === "assistant") turnCount += 1;
      if (ev.interrupted === true) interruptionCount += 1;

      const metrics = ev.metrics;
      if (metrics && typeof metrics === "object") {
        const mObj = metrics as Record<string, unknown>;

        // Latency samples — only assistant messages carry these keys
        // by convention, so no explicit role check needed.
        const ttft = extractSeconds(mObj, TTFT_KEYS);
        if (ttft != null) ttftMs.push(Math.round(ttft * 1000));
        const ttfb = extractSeconds(mObj, TTFB_KEYS);
        if (ttfb != null) ttfbMs.push(Math.round(ttfb * 1000));

        // Usage: try metrics-nested first (the LiveKit convention),
        // then fall back to top-level on the event itself for plugins
        // that shape it differently.
        if (!addUsageSample(usageSamples, mObj)) {
          addUsageSample(usageSamples, ev);
        }
      } else {
        addUsageSample(usageSamples, ev);
      }
    } else if (type === "function_call") {
      toolCallCount += 1;
    } else if (type === "agent_handoff") {
      agentHandoffCount += 1;
    } else if (type === "usage") {
      // Standalone usage event — some SDKs emit one of these per LLM
      // call alongside the message events.
      addUsageSample(usageSamples, ev);
    }
  }

  const usage = summarizeUsage(usageSamples);

  return {
    ttft_p50_ms: percentile(ttftMs, 50),
    ttft_p95_ms: percentile(ttftMs, 95),
    ttft_avg_ms: average(ttftMs),
    ttfb_p50_ms: percentile(ttfbMs, 50),
    ttfb_p95_ms: percentile(ttfbMs, 95),
    ttfb_avg_ms: average(ttfbMs),
    turn_count: turnCount,
    tool_call_count: toolCallCount,
    interruption_count: interruptionCount,
    agent_handoff_count: agentHandoffCount,
    ttft_sample_count: ttftMs.length,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    cached_prompt_tokens: usage.cached_prompt_tokens,
    estimated_cost_usd: usage.estimated_cost_usd,
  };
}

/** Extract one usage sample from a record. Returns true when something
 * was found (so the caller can stop hunting through fallback paths). */
function addUsageSample(
  samples: UsageSample[],
  raw: Record<string, unknown>,
): boolean {
  const prompt = extractNonNegInt(raw, PROMPT_TOKEN_KEYS);
  const completion = extractNonNegInt(raw, COMPLETION_TOKEN_KEYS);
  const total = extractNonNegInt(raw, TOTAL_TOKEN_KEYS);
  if (prompt == null && completion == null && total == null) return false;

  // Cached prompt tokens — surfaced under several names depending on
  // provider/SDK:
  //   OpenAI:    prompt_tokens_details.cached_tokens
  //   Anthropic: cache_read_input_tokens (top-level on usage)
  //   Generic:   cached_prompt_tokens / cached_tokens / llm_cache_read_tokens
  const promptDetails = raw.prompt_tokens_details ?? raw.promptTokensDetails;
  const cachedFromDetails =
    promptDetails && typeof promptDetails === "object"
      ? extractNonNegInt(
          promptDetails as Record<string, unknown>,
          ["cached_tokens", "cachedTokens"],
        )
      : null;
  const cached = extractNonNegInt(raw, CACHED_TOKEN_KEYS) ?? cachedFromDetails;

  // Provider/model identifier — top-level first, then nested
  // `llm_metadata` (LiveKit's canonical nesting for per-call metadata).
  const llmMetadata = raw.llm_metadata ?? raw.llmMetadata;
  const llmMetaObj =
    llmMetadata && typeof llmMetadata === "object"
      ? (llmMetadata as Record<string, unknown>)
      : null;
  const provider =
    extractString(raw, PROVIDER_KEYS) ??
    (llmMetaObj ? extractString(llmMetaObj, PROVIDER_KEYS) : null);
  const model =
    extractString(raw, MODEL_KEYS) ??
    (llmMetaObj ? extractString(llmMetaObj, MODEL_KEYS) : null);

  // Resolve resolved-prompt-tokens with fallback to total - completion
  // when prompt isn't directly carried but the others are.
  const promptResolved = Math.max(
    0,
    prompt ?? Math.max(0, (total ?? 0) - (completion ?? 0)),
  );
  const completionResolved = Math.max(0, completion ?? 0);
  // Trust the event's total when present; otherwise derive from
  // prompt + completion. Matches the session-side metrics.ts pattern.
  const totalResolved = Math.max(
    0,
    total ?? promptResolved + completionResolved,
  );
  // cached_prompt_tokens is a SUBSET of prompt_tokens — cap so a
  // misreported cached count can't exceed the actual prompt.
  const cachedResolved = Math.min(promptResolved, Math.max(0, cached ?? 0));

  samples.push({
    provider,
    model,
    prompt_tokens: promptResolved,
    cached_prompt_tokens: cachedResolved,
    completion_tokens: completionResolved,
    total_tokens: totalResolved,
  });
  return true;
}

/**
 * Cost from a LiveKit `session_metrics.usage[]` array (the OTLP
 * back-fill shape: a list of `{ type: 'llm_usage'|'tts_usage'|'stt_usage',
 * model, provider, input_tokens, output_tokens, ... }` entries).
 *
 * Filters to `type === 'llm_usage'` because models.dev only carries LLM
 * rates — TTS/STT entries carry tokens for accounting but aren't in the
 * price table, and passing them through `summarizeUsage` would null the
 * whole sum (one unpriceable sample with tokens > 0 forces cost → null).
 *
 * Returns null when no LLM samples are present so the caller can leave
 * the column NULL rather than persisting a misleading $0.
 */
export function costFromSessionUsage(usage: unknown): number | null {
  if (!Array.isArray(usage)) return null;
  const samples: UsageSample[] = [];
  for (const entry of usage) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    if (obj.type !== "llm_usage") continue;
    addUsageSample(samples, obj);
  }
  if (samples.length === 0) return null;
  return summarizeUsage(samples).estimated_cost_usd;
}

/** Aggregate per-sample usage into per-case (or per-run) totals,
 * with cost summed at per-sample rates and a conservative null
 * fallthrough for any unpriced sample. */
function summarizeUsage(samples: UsageSample[]) {
  let prompt_tokens = 0;
  let cached_prompt_tokens = 0;
  let completion_tokens = 0;
  let total_tokens = 0;
  // Start at 0 (no tokens to price → $0). Becomes null the moment a
  // sample has tokens but no matching price record. Pinned non-null
  // when at least one sample priced cleanly. We never resurrect a
  // null cost.
  let cost: number | null = 0;

  for (const s of samples) {
    prompt_tokens += s.prompt_tokens;
    cached_prompt_tokens += s.cached_prompt_tokens;
    completion_tokens += s.completion_tokens;
    total_tokens += s.total_tokens;

    const price = priceFor(s.provider, s.model);
    if (!price) {
      if (s.prompt_tokens > 0 || s.completion_tokens > 0) {
        cost = null;
      }
    } else if (cost != null) {
      const cached = s.cached_prompt_tokens;
      const fresh = Math.max(0, s.prompt_tokens - cached);
      const cachedRate = price.cache_read ?? price.input;
      cost += (fresh / 1_000_000) * price.input;
      cost += (cached / 1_000_000) * cachedRate;
      cost += (s.completion_tokens / 1_000_000) * price.output;
    }
  }

  return {
    prompt_tokens,
    cached_prompt_tokens,
    completion_tokens,
    total_tokens,
    // Round to 6 dp — sub-cent precision but no floating-point noise.
    estimated_cost_usd: cost == null ? null : Number(cost.toFixed(6)),
  };
}

function extractSeconds(
  obj: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

function extractNonNegInt(
  obj: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      // Token counts are integers in protocol but floats are tolerated;
      // floor defensively so we don't store fractional counts.
      return Math.floor(v);
    }
  }
  return null;
}

function extractString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

/** Linear interpolation between closest ranks. Standard, NumPy-default
 * algorithm. Single-sample arrays return that sample for any
 * percentile (trivially the only value). Empty arrays return null. */
function percentile(arr: number[], p: number): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

function average(arr: number[]): number | null {
  if (arr.length === 0) return null;
  return Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
}
