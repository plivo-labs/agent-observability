import type { EvalCase } from "./schema.js";

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
}

/**
 * Rule: a case counts as `passed` when status==="passed" AND no judgment has
 * verdict==="fail". "maybe" verdicts do not demote a case. `errored` and
 * `skipped` pass through orthogonally.
 */
export function summarize(cases: EvalCase[]): RunSummary {
  const summary: RunSummary = { total: cases.length, passed: 0, failed: 0, errored: 0, skipped: 0 };
  for (const c of cases) {
    if (c.status === "errored") summary.errored++;
    else if (c.status === "skipped") summary.skipped++;
    else if (c.status === "passed" && !(c.judgments ?? []).some((j) => (j as any).verdict === "fail")) summary.passed++;
    else summary.failed++;
  }
  return summary;
}

export interface CaseMetrics {
  ttfts_ms: number[];
  ttfbs_ms: number[];
  turn_count: number;
  tool_call_count: number;
  interruption_count: number;
  agent_handoff_count: number;
  ttft_p50_ms: number | null;
  ttft_p95_ms: number | null;
  ttft_avg_ms: number | null;
  ttfb_p50_ms: number | null;
  ttfb_p95_ms: number | null;
  ttfb_avg_ms: number | null;
  ttft_sample_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number | null;
}

interface UsageSample {
  provider: string | null;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
}

interface ModelPrice {
  input: number;
  output: number;
}

const PRICES_PER_1M_TOKENS_USD: Record<string, ModelPrice> = {
  "openai:gpt-4.1": { input: 2, output: 8 },
  "openai:gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "openai:gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "openai:gpt-4o": { input: 2.5, output: 10 },
  "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
  "anthropic:claude-3-5-sonnet": { input: 3, output: 15 },
  "anthropic:claude-3-7-sonnet": { input: 3, output: 15 },
  "anthropic:claude-sonnet-4": { input: 3, output: 15 },
  "anthropic:claude-opus-4": { input: 15, output: 75 },
};

/** Walk events for a single case, extracting latency samples and counts. */
export function computeCaseMetrics(events: unknown[]): CaseMetrics {
  const ttfts: number[] = [];
  const ttfbs: number[] = [];
  const usageSamples: UsageSample[] = [];
  let turn_count = 0;
  let tool_call_count = 0;
  let interruption_count = 0;
  let agent_handoff_count = 0;

  for (const raw of events) {
    if (raw == null || typeof raw !== "object") continue;
    const ev = raw as Record<string, unknown>;
    const type = ev.type;
    if (type === "message") {
      if (ev.role === "assistant") turn_count++;
      if (ev.interrupted === true) interruption_count++;
      const metrics = ev.metrics as Record<string, unknown> | null | undefined;
      if (metrics && typeof metrics === "object") {
        const ttft = metrics.llm_node_ttft;
        if (typeof ttft === "number") ttfts.push(ttft * 1000);
        const ttfb = metrics.tts_node_ttfb;
        if (typeof ttfb === "number") ttfbs.push(ttfb * 1000);
        if (addUsageSample(usageSamples, metrics)) continue;
      }
      addUsageSample(usageSamples, ev);
    } else if (type === "function_call") {
      tool_call_count++;
    } else if (type === "agent_handoff") {
      agent_handoff_count++;
    } else if (type === "usage") {
      addUsageSample(usageSamples, ev);
    }
  }

  const usage = summarizeUsage(usageSamples);

  return {
    ttfts_ms: ttfts,
    ttfbs_ms: ttfbs,
    turn_count,
    tool_call_count,
    interruption_count,
    agent_handoff_count,
    ttft_p50_ms: percentile(ttfts, 50),
    ttft_p95_ms: percentile(ttfts, 95),
    ttft_avg_ms: avg(ttfts),
    ttfb_p50_ms: percentile(ttfbs, 50),
    ttfb_p95_ms: percentile(ttfbs, 95),
    ttfb_avg_ms: avg(ttfbs),
    ttft_sample_count: ttfts.length,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    estimated_cost_usd: usage.estimated_cost_usd,
  };
}

function addUsageSample(samples: UsageSample[], raw: Record<string, unknown>): boolean {
  const promptTokens = numberFrom(raw.llm_prompt_tokens ?? raw.prompt_tokens ?? raw.input_tokens);
  const completionTokens = numberFrom(raw.llm_completion_tokens ?? raw.completion_tokens ?? raw.output_tokens);
  const totalTokens = numberFrom(raw.llm_total_tokens ?? raw.total_tokens);
  if (promptTokens == null && completionTokens == null && totalTokens == null) return false;

  const metadata = raw.llm_metadata as Record<string, unknown> | null | undefined;
  samples.push({
    provider: stringFrom(raw.provider ?? raw.model_provider ?? metadata?.model_provider),
    model: stringFrom(raw.model ?? raw.model_name ?? metadata?.model_name),
    prompt_tokens: promptTokens ?? Math.max(0, (totalTokens ?? 0) - (completionTokens ?? 0)),
    completion_tokens: completionTokens ?? 0,
  });
  return true;
}

function summarizeUsage(samples: UsageSample[]) {
  let prompt_tokens = 0;
  let completion_tokens = 0;
  let cost: number | null = 0;

  for (const sample of samples) {
    prompt_tokens += sample.prompt_tokens;
    completion_tokens += sample.completion_tokens;

    const price = priceFor(sample.provider, sample.model);
    if (!price) {
      if (sample.prompt_tokens > 0 || sample.completion_tokens > 0) cost = null;
    } else if (cost != null) {
      cost += (sample.prompt_tokens / 1_000_000) * price.input;
      cost += (sample.completion_tokens / 1_000_000) * price.output;
    }
  }

  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    estimated_cost_usd: cost == null ? null : Number(cost.toFixed(6)),
  };
}

function priceFor(provider: string | null, model: string | null): ModelPrice | null {
  if (!provider || !model) return null;
  const providerKey = normalizeProvider(provider);
  const modelKey = normalizeModel(model);
  return PRICES_PER_1M_TOKENS_USD[`${providerKey}:${modelKey}`] ?? null;
}

function normalizeProvider(provider: string): string {
  return provider.toLowerCase().replace(/^@/, "").replace(/[-_ ]/g, "");
}

function normalizeModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/-20\d{2}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
}

function numberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringFrom(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function percentile(values: number[], pct: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[idx];
}

export function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
