// One classification policy for "would this error fail identically on retry?"
// — shared by every retry/skip decision (the OTLP persist path and the eval
// sweeper today). Previously each site hand-rolled its own classifier with
// opposite defaults; the LOGIC now lives here once and only the site-specific
// DEFAULT stays at the call site:
//
//   • persist (livekit/observability.ts): unknown → TRANSIENT. Skipping a
//     record drops ingested data, which needs positive evidence that a retry
//     can't succeed.
//   • eval sweep (evals-engine/eval-sweeper.ts): unknown → DETERMINISTIC.
//     Retrying re-spends LLM budget on every stale-adoption cycle, so a retry
//     needs positive evidence that the failure was environmental.
//
// Classification order (first match wins):
//   1. Structured SQLSTATE when present — Postgres attaches `code`. Classes
//      22 (data exception — incl. 22P05 jsonb NUL), 23 (integrity constraint)
//      and 42 (syntax/access) are deterministic: the same input fails
//      identically every time. Any OTHER coded error (e.g. class 08
//      connection, 57 operator intervention) is environmental.
//   2. Message text across the `cause` chain. The LLM layer has no structured
//      status field (LlmError wraps the provider error as `cause`, and the
//      providers put the HTTP status in message text only), so text matching
//      is all that's available for provider errors. A positive TRANSIENT
//      signal is checked first: an environmental marker (timeout / 429 / 5xx
//      / network) beats a content match in the same message.
//      Auth failures (401/403/expired or rotated key) count as transient on
//      purpose — they're environmental, not input-determined; treating them
//      as deterministic would permanently poison work claimed during a
//      key-rotation gap.
//      Status codes are word-boundary anchored: a bare `50[0-9]` would match
//      the "500" inside token counts like "1500" in judge error messages and
//      misclassify a deterministic failure as transient (endless re-judging).

export type ErrorDurability = "transient" | "deterministic" | "unknown";

const TRANSIENT_SIGNALS =
  /timeout|timed.?out|\b429\b|rate.?limit|too many requests|\b50[0-9]\b|overloaded|unavailable|unable to connect|connection (refused|reset|closed|error)|ECONN|ENOTFOUND|EAI_AGAIN|network|socket|fetch failed|\b40[13]\b|unauthoriz|forbidden|invalid.?api.?key|authentication|permission denied/i;

const DETERMINISTIC_SIGNALS =
  /constraint|duplicate key|invalid input|value too long|out of range|null value|syntax|malformed|unsupported unicode|invalid byte sequence/i;

export function classifyErrorDurability(e: unknown): ErrorDurability {
  const raw = e as { code?: string; errno?: string | number };
  // Bun's SQL.PostgresError carries its own class name in `code`
  // ("ERR_POSTGRES_SERVER_ERROR") and the REAL Postgres SQLSTATE in `errno`
  // (verified empirically on bun 1.3.14 against PG 17). Reading only `code`
  // classified EVERY Postgres error as transient — endless re-judging of
  // deterministic failures like 23505/22P05. Prefer errno when it looks like
  // a SQLSTATE.
  const errno = String(raw?.errno ?? "");
  const code = /^[0-9A-Z]{5}$/.test(errno) ? errno : (raw?.code ?? "");
  if (/^(22|23|42)/.test(code)) return "deterministic";
  if (code) return "transient";

  const seen = new Set<unknown>();
  let messages = "";
  for (let cur = e; cur && typeof cur === "object" && !seen.has(cur); cur = (cur as { cause?: unknown }).cause) {
    seen.add(cur);
    messages += ` ${(cur as Error).message ?? ""}`;
  }
  if (TRANSIENT_SIGNALS.test(messages)) return "transient";
  if (DETERMINISTIC_SIGNALS.test(messages)) return "deterministic";
  return "unknown";
}
