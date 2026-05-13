import type { Hono } from "hono";
import {
  getAgent,
  getAgentStats,
  listAgents,
  listConversationEvals,
} from "./db.js";
import { buildErrorResponse, buildListResponse, newApiId } from "../response.js";

const ALLOWED_RANGES = new Set(["24h", "7d", "30d"]);

export function registerAgentRoutes(app: Hono) {
  // ── List ─────────────────────────────────────────────────────────────────
  //
  // Paginated. The data table on the frontend uses page-size 10–50; the
  // server clamps to [1, 200] in case a caller asks for more.
  //
  // Filters:
  //   - account_id   — scope into one tenant
  //   - agent_id     — exact match (lookup from agent detail URL)
  //   - agent_name   — case-insensitive substring search on the label
  app.get("/api/agents", async (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
    const offset = Math.max(0, Number(c.req.query("offset")) || 0);
    const accountId = c.req.query("account_id") || null;
    const agentId = c.req.query("agent_id") || null;
    const agentName = c.req.query("agent_name") || null;
    const extraParams: Record<string, string> = {};
    if (accountId) extraParams.account_id = accountId;
    if (agentId) extraParams.agent_id = agentId;
    if (agentName) extraParams.agent_name = agentName;

    const { rows, total } = await listAgents({
      limit,
      offset,
      accountId,
      agentId,
      agentName,
    });

    return c.json(
      buildListResponse(rows, limit, offset, total, "/api/agents", extraParams),
    );
  });

  // ── Detail ───────────────────────────────────────────────────────────────
  //
  // Lookup by (agent_id, optional account_id). Agents are unique within
  // an account, so the same agent_id under a different account is a
  // different row. account_id arrives as a query param; if omitted, we
  // return the most-recently-active match (matches listAgents' ordering).
  app.get("/api/agents/:agent_id", async (c) => {
    const id = c.req.param("agent_id");
    const accountId = c.req.query("account_id") || null;
    const agent = await getAgent(id, accountId);
    if (!agent) {
      return c.json(buildErrorResponse("not_found", "Agent not found"), 404);
    }
    return c.json({ api_id: newApiId(), ...agent });
  });

  // ── Stats (Overview tab) ─────────────────────────────────────────────────
  //
  // KPI totals + bucketed series for charts. Scoped by (agent_id,
  // optional account_id) so two same-name agents in different accounts
  // get their own numbers. `range` clamps to a known set.
  app.get("/api/agents/:agent_id/stats", async (c) => {
    const id = c.req.param("agent_id");
    const accountId = c.req.query("account_id") || null;
    const rangeParam = c.req.query("range") ?? "24h";
    const range = ALLOWED_RANGES.has(rangeParam) ? rangeParam : "24h";
    try {
      const stats = await getAgentStats(id, range, accountId);
      return c.json({ api_id: newApiId(), ...stats });
    } catch (e) {
      const err = e as Error;
      // Log full error server-side (stack + message + context) and
      // respond with a structured 500 so the UI shows a real message.
      console.error(
        `[agents] stats failed agent_id=${id} account_id=${accountId ?? "(any)"} range=${range}: ${err.message}\n${err.stack ?? ""}`,
      );
      return c.json(
        buildErrorResponse("stats_failed", `Failed to compute stats: ${err.message}`),
        500,
      );
    }
  });

  // ── Conversation Evals (per-agent eval rollup) ──────────────────────────
  //
  // Lists sessions for the agent that have any conversation-eval data
  // attached — session_external_evals (LiveKit JudgeGroup verdicts) or
  // session_outcomes. Each row carries the full eval + tag arrays so
  // the table can render verdict counts + chips without a second fetch.
  app.get("/api/agents/:agent_id/conversation-evals", async (c) => {
    const agentId = c.req.param("agent_id");
    const accountId = c.req.query("account_id") || null;
    const sessionId = c.req.query("session_id") || null;
    const failedOnly = c.req.query("failed") === "true";
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
    const offset = Math.max(0, Number(c.req.query("offset")) || 0);

    const extraParams: Record<string, string> = {};
    if (accountId) extraParams.account_id = accountId;
    if (sessionId) extraParams.session_id = sessionId;
    if (failedOnly) extraParams.failed = "true";

    try {
      const { rows, total } = await listConversationEvals({
        agentId,
        accountId,
        sessionId,
        failedOnly,
        limit,
        offset,
      });
      return c.json(
        buildListResponse(
          rows,
          limit,
          offset,
          total,
          `/api/agents/${encodeURIComponent(agentId)}/conversation-evals`,
          extraParams,
        ),
      );
    } catch (e) {
      const err = e as Error;
      console.error(
        `[agents] conversation-evals failed agent_id=${agentId} account_id=${accountId ?? "(any)"}: ${err.message}\n${err.stack ?? ""}`,
      );
      return c.json(
        buildErrorResponse(
          "conversation_evals_failed",
          `Failed to load conversation evals: ${err.message}`,
        ),
        500,
      );
    }
  });
}
