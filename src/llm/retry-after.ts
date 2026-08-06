/**
 * `Retry-After` handling for provider rate limits.
 *
 * Azure/OpenAI answer a 429 with a `Retry-After` telling you when the quota
 * window reopens — commonly 1-60s. Without reading it, `completeJSON`'s
 * exponential backoff sleeps 400ms then 800ms and gives up, which cannot help
 * when a whole minute's TPM allowance is gone: all three attempts land inside
 * the same exhausted window. Observed on dev 2026-08-05, where a judge fan-out
 * produced 182 429s and the attempt counts barely decayed (63 -> 60 -> 58).
 *
 * Pure and provider-agnostic so it can be unit-tested without a socket. The two
 * shapes it has to read are both real: the Responses path throws from a raw
 * `fetch` (we attach the parsed hint), while the Chat path throws the OpenAI
 * SDK's own error, which carries `headers`.
 */

/**
 * Ceiling on an honoured hint. A server (or a proxy) can name a delay longer
 * than the caller is willing to wait; the per-attempt timeout would fire
 * mid-sleep and the wait would have bought nothing. 30s is above Azure's
 * typical hint and below any sane request timeout.
 */
export const RETRY_AFTER_CAP_MS = 30_000;

/** Parse a `Retry-After` header value: delta-seconds or an HTTP-date. */
export function parseRetryAfter(raw: string | null | undefined, now = Date.now()): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // delta-seconds — the form Azure sends. Number("") is 0, hence the guard above.
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return null;
    return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  }

  // HTTP-date. Already-past dates mean "retry now", not "wait forever".
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - now, 0), RETRY_AFTER_CAP_MS);
}

/**
 * Is this the provider saying "you are over your quota"?
 *
 * Narrow on purpose. It gates the model fallback, and a 500 or a timeout is not a
 * capacity problem — switching model cannot fix it and the fallback is ~25x the
 * price. Only a genuine 429 should buy a call the more expensive model.
 *
 * Same two shapes as the hint reader: `status` from the OpenAI SDK's error on the
 * Chat path, and a message beginning "429" from the raw-fetch Responses path
 * (see httpError in providers/openai.ts). The message check is anchored so a 429
 * quoted inside a body preview cannot false-positive.
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; message?: unknown };
  if (e.status === 429) return true;
  return typeof e.message === "string" && /^429\b/.test(e.message);
}

/**
 * Pull a hint off whatever the provider threw, or null when there isn't one.
 *
 * Deliberately duck-typed rather than keyed off an error class: the Chat path's
 * error comes from the OpenAI SDK and is not ours to subclass, and a `headers`
 * bag may be a `Headers` instance or a plain object depending on version.
 */
export function retryAfterMsFromError(err: unknown, now = Date.now()): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { retryAfterMs?: unknown; headers?: unknown };

  // Attached by our own fetch paths (providers/openai.ts) — already parsed and capped.
  if (typeof e.retryAfterMs === "number" && Number.isFinite(e.retryAfterMs)) {
    return Math.min(Math.max(e.retryAfterMs, 0), RETRY_AFTER_CAP_MS);
  }

  const h = e.headers;
  if (h && typeof (h as Headers).get === "function") {
    return parseRetryAfter((h as Headers).get("retry-after"), now);
  }
  if (h && typeof h === "object") {
    const rec = h as Record<string, unknown>;
    const v = rec["retry-after"] ?? rec["Retry-After"];
    return typeof v === "string" ? parseRetryAfter(v, now) : null;
  }
  return null;
}
