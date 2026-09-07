import type { Hono } from "hono";
import { buildErrorResponse, newApiId } from "../response.js";
import { getFleetStats } from "./db.js";
import { getMetricFailedRuns, getMetricsAnalytics } from "./metrics-analytics.js";

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

  // ── Per-metric analytics (AI-agent performance page) ──────────────────────
  //
  // Pass rate / calls / trend / Δ-vs-prior for every judge that fired in the
  // window — default checks and custom metrics — plus the KPI row. Optional
  // agent scope narrows to one flow. Account is gateway-injected (X-Account-Id)
  // or the query param on single-tenant installs.
  app.get("/api/analytics/metrics", async (c) => {
    const accountId = c.req.header("x-account-id") || c.req.query("account_id") || null;
    // One or more agent flows: repeated ?agent_id=a&agent_id=b or a comma list.
    const agentIds = (c.req.queries("agent_id") ?? [])
      .flatMap((v) => v.split(","))
      .map((s) => s.trim())
      .filter(Boolean);
    const agentIdsOrNull = agentIds.length ? agentIds : null;
    const rangeParam = c.req.query("range") ?? "7d";
    const range = ALLOWED_RANGES.has(rangeParam) ? rangeParam : "7d";
    const targetRaw = Number(c.req.query("target"));
    const target = Number.isFinite(targetRaw) && targetRaw > 0 && targetRaw <= 1 ? targetRaw : 0.75;
    try {
      const data = await getMetricsAnalytics({ range, accountId, agentIds: agentIdsOrNull, target });
      return c.json({ api_id: newApiId(), ...data });
    } catch (e) {
      const err = e as Error;
      console.error(
        `[analytics] metrics failed account_id=${accountId ?? "(any)"} agent_id=${agentIdsOrNull?.join(",") ?? "(any)"} range=${range}: ${err.message}\n${err.stack ?? ""}`,
      );
      return c.json(buildErrorResponse("metrics_failed", "Failed to compute metrics analytics"), 500);
    }
  });

  // ── Failed runs behind one metric (drill-down) ────────────────────────────
  //
  // The flow_run_uuids of the sessions that FAILED `metric` (a judge name, e.g.
  // `metric:<slug>`) in the window, so the client can filter its runs table to
  // them. Same account/agent/range scope as the metrics route.
  app.get("/api/analytics/metric-failed-runs", async (c) => {
    const accountId = c.req.header("x-account-id") || c.req.query("account_id") || null;
    const agentIds = (c.req.queries("agent_id") ?? [])
      .flatMap((v) => v.split(","))
      .map((s) => s.trim())
      .filter(Boolean);
    const agentIdsOrNull = agentIds.length ? agentIds : null;
    const metric = c.req.query("metric") || "";
    const rangeParam = c.req.query("range") ?? "7d";
    const range = ALLOWED_RANGES.has(rangeParam) ? rangeParam : "7d";
    if (!metric) {
      return c.json(buildErrorResponse("metric_required", "metric query param is required"), 400);
    }
    try {
      const data = await getMetricFailedRuns({ range, accountId, agentIds: agentIdsOrNull, judgeName: metric });
      return c.json({ api_id: newApiId(), ...data });
    } catch (e) {
      const err = e as Error;
      console.error(
        `[analytics] metric-failed-runs failed account_id=${accountId ?? "(any)"} agent_id=${agentIdsOrNull?.join(",") ?? "(any)"} metric=${metric} range=${range}: ${err.message}\n${err.stack ?? ""}`,
      );
      return c.json(
        buildErrorResponse("metric_failed_runs_failed", "Failed to fetch failed runs"),
        500,
      );
    }
  });
}
