import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { config } from "./config.js";
import { sql } from "./db.js";

/** Account assertions are accepted only from authenticated gateway callers.
 * With required scope off, absent context retains trusted administrative access. */
export function accountScope(c: Pick<Context, "req">): string | null {
  const raw = c.req.header("x-account-id");
  const accountId = raw?.trim();
  if ((raw !== undefined && !accountId) || (config.REQUIRE_ACCOUNT_SCOPE && !accountId)) {
    throw new HTTPException(401, { message: "Account context required" });
  }
  return accountId ?? null;
}

export const accountScopeGuard: MiddlewareHandler = async (c, next) => {
  accountScope(c);
  await next();
};

export class SessionAccessError extends Error {
  constructor() { super("One or more sessions are not accessible"); }
}

/** Authorize the whole batch before reading transcripts or starting an LLM. */
export async function assertSessionAccess(ids: string[], accountId: string | null): Promise<void> {
  if (accountId === null) return;
  const literal = `{${ids.map(id => `"${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
  const rows = await sql`SELECT session_id FROM ao_agent_transport_sessions
    WHERE session_id = ANY(${literal}::text[]) AND account_id = ${accountId}`;
  const allowed = new Set(rows.map((row: { session_id: string }) => row.session_id));
  if (ids.some(id => !allowed.has(id))) throw new SessionAccessError();
}
