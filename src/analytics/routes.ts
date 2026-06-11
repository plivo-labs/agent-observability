import type { Hono } from "hono";
import { buildErrorResponse, newApiId } from "../response.js";
import { getFleetStats } from "./db.js";

const ALLOWED_RANGES = new Set(["24h", "7d", "30d"]);

export function registerAnalyticsRoutes(app: Hono) {
  // ── Fleet-wide stats ──────────────────────────────────────────────────────
  //
  // Same engine as the per-agent stats route, across ALL agents in the
  // window (optional account scope). Powers the /analytics dashboard page.
  app.get("/api/analytics/stats", async (c) => {
    const accountId = c.req.query("account_id") || null;
    const rangeParam = c.req.query("range") ?? "7d";
    const range = ALLOWED_RANGES.has(rangeParam) ? rangeParam : "7d";
    try {
      const stats = await getFleetStats(range, accountId);
      return c.json({ api_id: newApiId(), ...stats });
    } catch (e) {
      const err = e as Error;
      console.error(
        `[analytics] stats failed account_id=${accountId ?? "(any)"} range=${range}: ${err.message}\n${err.stack ?? ""}`,
      );
      return c.json(
        // Don't leak err.message to the client — Postgres errors disclose
        // table/column/constraint names. Full detail is logged above.
        buildErrorResponse("stats_failed", "Failed to compute stats"),
        500,
      );
    }
  });
}
