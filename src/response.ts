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
