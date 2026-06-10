import { randomUUID } from "crypto";

/** Generate a new api_id (UUID v4) for Plivo-standard responses. */
export function newApiId(): string {
  return randomUUID();
}

/** Build a full URL with query parameters for pagination links. */
function buildUrl(basePath: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/** Build a Plivo-standard paginated list response. */
export function buildListResponse<T>(
  objects: T[],
  limit: number,
  offset: number,
  totalCount: number,
  basePath: string,
  extraParams?: Record<string, string>
) {
  const base = extraParams ? { ...extraParams } : {};

  const next =
    offset + limit < totalCount
      ? buildUrl(basePath, { ...base, limit: String(limit), offset: String(offset + limit) })
      : null;
  const previous =
    offset > 0
      ? buildUrl(basePath, { ...base, limit: String(limit), offset: String(Math.max(0, offset - limit)) })
      : null;

  return {
    api_id: newApiId(),
    meta: { limit, offset, total_count: totalCount, next, previous },
    objects,
  };
}

/** Build a Plivo-standard error response. */
export function buildErrorResponse(code: string, message: string) {
  return {
    api_id: newApiId(),
    error: { code, message },
  };
}

/** Escape `%`, `_`, and `\` so user-typed text is treated as literal
 *  characters inside a SQL LIKE pattern. The caller is expected to
 *  wrap the result in `%...%` for substring matching.
 *  e.g. user types `50%` → `50\%` → matches the literal "50%". */
export function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

/** Parse + clamp a `limit` query param. Each route family keeps its own
 *  ceiling — pass it explicitly so the bound is visible at the call site. */
export function parseLimit(
  raw: string | undefined,
  { fallback, max }: { fallback: number; max: number },
): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

/** Compact zod-error rendering for `invalid_payload` responses — first
 *  five issues as `path: message`, joined. */
export function formatZodError(err: unknown): string {
  try {
    const issues = (err as any)?.issues;
    if (Array.isArray(issues)) {
      return issues
        .slice(0, 5)
        .map((i: any) => {
          const path = Array.isArray(i.path) ? i.path.join(".") : "";
          return path ? `${path}: ${i.message}` : i.message;
        })
        .join("; ");
    }
  } catch {}
  return "Validation failed";
}
