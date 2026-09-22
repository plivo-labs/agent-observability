import { z } from "zod";
import { config } from "../config.js";
import { costForTokens } from "../evals/pricing.js";
import { JEV_OVERFLOW, JevError, type JevClient, type JevNoulAnswer, type JevRequest, type JevResponse } from "./types.js";

// Thin HTTP client for POST /v1/systemone (wire shape captured from the
// official SDK). It owns transport concerns only — timeout, retries, the
// concurrency cap, response validation and the usage line; which questions to
// ask and what a probability means live in src/evals-engine/jev/.

const SYSTEM_ONE_PATH = "/v1/systemone";
const RETRYABLE = new Set([408, 429, 529]);
const MAX_RETRY_AFTER_MS = 10_000;

const NoulAnswerZ = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) });
const ResponseZ = z.object({
  model: z.string().default(""),
  usage: z.object({ input_tokens: z.number().default(0), output_tokens: z.number().default(0) }).default({ input_tokens: 0, output_tokens: 0 }),
  answers: z.record(z.string(), z.unknown()).default({}),
});

export interface HttpJevClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxConcurrent?: number;
  /** Retries after the first attempt on 408/429/529/5xx/network. */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

function retryAfterMs(res: Response): number | null {
  const ms = res.headers.get("retry-after-ms");
  if (ms && /^\d+$/.test(ms)) return Math.min(Number(ms), MAX_RETRY_AFTER_MS);
  const ra = res.headers.get("retry-after");
  if (!ra) return null;
  if (/^\d+$/.test(ra)) return Math.min(Number(ra) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(ra);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), MAX_RETRY_AFTER_MS)) : null;
}

async function errorTypeOf(res: Response): Promise<string> {
  if (res.status === 529) return "overloaded";
  try {
    const body = (await res.json()) as { detail?: { error_type?: string } | string; error?: { type?: string } };
    if (body && typeof body.detail === "object" && body.detail?.error_type) return body.detail.error_type;
    if (body && typeof body.detail === "string") return body.detail.slice(0, 80);
    if (body?.error?.type) return body.error.type;
  } catch {
    /* non-JSON error body */
  }
  return res.statusText || `http_${res.status}`;
}

export class HttpJevClient implements JevClient {
  readonly name = "typesafe";
  private readonly apiKey: string;
  private readonly url: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(opts: HttpJevClientOptions) {
    this.apiKey = opts.apiKey;
    this.url = (opts.baseUrl ?? "https://api.typesafe.ai").replace(/\/+$/, "") + SYSTEM_ONE_PATH;
    this.model = opts.model ?? "jev-1.13.0";
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 8);
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async systemOne(req: JevRequest): Promise<JevResponse> {
    await this.acquire();
    const startedAt = Date.now();
    let attempts = 0;
    try {
      const res = await this.send(req, (n) => { attempts = n; });
      this.logUsage(req, res, attempts, startedAt, "ok");
      return res;
    } catch (e) {
      this.logUsage(req, null, attempts, startedAt, "error");
      throw e;
    } finally {
      this.release();
    }
  }

  private async send(req: JevRequest, onAttempt: (n: number) => void): Promise<JevResponse> {
    const body = JSON.stringify({ model: this.model, state: req.state, questions: req.questions });
    let lastError: JevError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      onAttempt(attempt + 1);
      if (attempt > 0) await this.sleep(lastError?.status === 429 || lastError?.status === 529 ? (lastError.retryAfterMs ?? 300 * 2 ** attempt) : 300 * 2 ** attempt);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", accept: "application/json" },
          body,
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        lastError = controller.signal.aborted
          ? new JevError(408, "timeout", `${this.timeoutMs}ms`)
          : new JevError(0, "network", (e as Error).message);
        continue;
      }
      clearTimeout(timer);
      if (!res.ok) {
        const errorType = await errorTypeOf(res);
        const err = new JevError(res.status, errorType);
        // Overflow is deterministic for this request — retrying the same bytes
        // cannot succeed; the orchestrator routes the request's axes to Luna.
        if (res.status === 400 && errorType === JEV_OVERFLOW) throw err;
        if (RETRYABLE.has(res.status) || res.status >= 500) {
          err.retryAfterMs = retryAfterMs(res);
          lastError = err;
          continue;
        }
        throw err;
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch (e) {
        throw new JevError(res.status, "invalid_response", `body is not JSON: ${(e as Error).message}`);
      }
      const parsed = ResponseZ.safeParse(json);
      if (!parsed.success) throw new JevError(res.status, "invalid_response", parsed.error.issues[0]?.message);
      const answers: Record<string, JevNoulAnswer> = {};
      for (const [key, value] of Object.entries(parsed.data.answers)) {
        const a = NoulAnswerZ.safeParse(value);
        if (a.success && key in req.questions) answers[key] = a.data;
      }
      return { model: parsed.data.model, usage: parsed.data.usage, answers };
    }
    throw lastError ?? new JevError(0, "network", "no attempts");
  }

  private logUsage(req: JevRequest, res: JevResponse | null, attempts: number, startedAt: number, outcome: "ok" | "error"): void {
    const prompt = res?.usage.input_tokens ?? 0;
    const completion = res?.usage.output_tokens ?? 0;
    const cost = costForTokens("typesafe", this.model, { promptTokens: prompt, completionTokens: completion });
    const ratio = prompt > 0 && req.estTokens > 0 ? (prompt / req.estTokens).toFixed(2) : "-";
    // Same line shape as completeJSON's so the cost report groups it with the
    // LLM judges; est_ratio is how the token estimator's calibration is watched.
    console.log(
      `[llm] usage label=jev role=judge model=${res?.model || this.model} provider=typesafe ` +
        `correlation_id=${req.key} prompt_tokens=${prompt} completion_tokens=${completion} ` +
        `reasoning_tokens=0 total_tokens=${prompt + completion} attempts=${attempts} ` +
        `duration_ms=${Date.now() - startedAt} cost_usd=${cost === null ? "unknown" : cost.toFixed(6)} ` +
        `outcome=${outcome} est_tokens=${req.estTokens} est_ratio=${ratio} questions=${Object.keys(req.questions).length}`,
    );
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); // slot handed over directly; `active` count is unchanged
    else this.active--;
  }
}

let warnedMissingKey = false;

/** The process-wide client for JEV_MODE=primary, or null when Jev is off or
 *  unusable — the caller then takes today's Luna-only path. */
export function createJevClientFromConfig(): JevClient | null {
  if ((config.JEV_MODE ?? "off") !== "primary") return null;
  const apiKey = config.JEV_API_KEY;
  if (!apiKey) {
    if (!warnedMissingKey) {
      console.warn("[jev] JEV_MODE=primary but JEV_API_KEY is unset — Jev disabled, judging on the LLM path");
      warnedMissingKey = true;
    }
    return null;
  }
  return new HttpJevClient({
    apiKey,
    baseUrl: config.JEV_BASE_URL,
    model: config.JEV_MODEL,
    timeoutMs: config.JEV_TIMEOUT_MS ?? 15_000,
    maxConcurrent: config.JEV_MAX_CONCURRENT ?? 8,
  });
}
