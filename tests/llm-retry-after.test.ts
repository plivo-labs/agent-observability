import { describe, expect, it } from "bun:test";
import { RETRY_AFTER_CAP_MS, parseRetryAfter, retryAfterMsFromError } from "../src/llm/retry-after.js";

// Why this exists: without an honoured Retry-After, completeJSON's exponential
// backoff sleeps 400ms then 800ms and gives up — useless against a TPM exhaustion
// where the whole minute's allowance is gone. Observed on dev 2026-08-05: 182 429s
// with attempt counts decaying only 63 -> 60 -> 58, i.e. all three attempts landed
// inside the same closed window.

const NOW = 1_700_000_000_000;

describe("parseRetryAfter", () => {
  it("reads delta-seconds, the form Azure sends", () => {
    expect(parseRetryAfter("1")).toBe(1000);
    expect(parseRetryAfter("17")).toBe(17_000);
    expect(parseRetryAfter("  4  ")).toBe(4000);
  });

  it("caps a long delay so the sleep can't outlast the per-attempt timeout", () => {
    expect(parseRetryAfter("600")).toBe(RETRY_AFTER_CAP_MS);
  });

  it("treats 0 as 'retry immediately', not as absent", () => {
    // 0 is a legitimate hint and must not collapse to null, or the caller would
    // fall back to the exponential guess and wait longer than asked.
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("reads the HTTP-date form relative to now", () => {
    expect(parseRetryAfter(new Date(NOW + 5000).toUTCString(), NOW)).toBe(5000);
  });

  it("clamps an already-past date to 0 rather than going negative", () => {
    expect(parseRetryAfter(new Date(NOW - 60_000).toUTCString(), NOW)).toBe(0);
  });

  it("returns null for absent, empty and unparseable values", () => {
    for (const v of [null, undefined, "", "   ", "soon", "NaN"]) {
      expect(parseRetryAfter(v)).toBeNull();
    }
  });

  it("rejects a negative delta rather than sleeping a negative time", () => {
    expect(parseRetryAfter("-5")).toBeNull();
  });
});

describe("retryAfterMsFromError", () => {
  it("reads the hint our fetch paths attach", () => {
    const err = Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 8000 });
    expect(retryAfterMsFromError(err)).toBe(8000);
  });

  it("re-caps an attached value — the field is writable by anyone", () => {
    const err = Object.assign(new Error("429"), { retryAfterMs: 10 * 60 * 1000 });
    expect(retryAfterMsFromError(err)).toBe(RETRY_AFTER_CAP_MS);
  });

  it("reads a Headers bag — the OpenAI SDK's shape on the Chat path", () => {
    const err = Object.assign(new Error("429"), { headers: new Headers({ "retry-after": "3" }) });
    expect(retryAfterMsFromError(err)).toBe(3000);
  });

  it("reads a plain-object header bag, either casing", () => {
    expect(retryAfterMsFromError({ headers: { "retry-after": "2" } })).toBe(2000);
    expect(retryAfterMsFromError({ headers: { "Retry-After": "2" } })).toBe(2000);
  });

  it("returns null when there is no hint to find", () => {
    expect(retryAfterMsFromError(new Error("500 Internal Server Error"))).toBeNull();
    expect(retryAfterMsFromError({ headers: {} })).toBeNull();
    expect(retryAfterMsFromError({ headers: { "retry-after": 5 } })).toBeNull(); // non-string
    expect(retryAfterMsFromError(null)).toBeNull();
    expect(retryAfterMsFromError("429")).toBeNull();
    expect(retryAfterMsFromError(undefined)).toBeNull();
  });

  it("prefers the attached field over the header bag when both are present", () => {
    // The attached value is already parsed and capped by the provider; the raw
    // header is the fallback for errors we didn't construct.
    const err = Object.assign(new Error("429"), {
      retryAfterMs: 1000,
      headers: new Headers({ "retry-after": "29" }),
    });
    expect(retryAfterMsFromError(err)).toBe(1000);
  });
});
