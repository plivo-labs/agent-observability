import type { Hono } from "hono";
import { buildErrorResponse, buildListResponse, newApiId } from "../response.js";
import {
  deleteAlertRule,
  getAlertRule,
  getWebhookStats,
  insertAlertRule,
  listAlertRules,
  listFirings,
  listWebhookAttempts,
  updateAlertRule,
} from "./db.js";
import { deliverTest } from "./deliver.js";
import { alertRuleCreateSchema, alertRulePatchSchema } from "./schema.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatZodError(err: unknown): string {
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

function clampLimit(raw: string | undefined, fallback = 20): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

export function registerAlertRoutes(app: Hono) {
  // ── Rules CRUD ────────────────────────────────────────────────────────────

  app.get("/api/alert-rules", async (c) => {
    const limit = clampLimit(c.req.query("limit"));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    const enabledParam = c.req.query("enabled");
    try {
      const { rules, totalCount } = await listAlertRules(limit, offset, {
        agentId: c.req.query("agent_id") || null,
        accountId: c.req.query("account_id") || null,
        enabled: enabledParam == null ? null : enabledParam === "true",
      });
      return c.json(buildListResponse(rules, limit, offset, totalCount, "/api/alert-rules"));
    } catch (e) {
      console.error(`[alerts] list failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("list_failed", "Failed to list alert rules"), 500);
    }
  });

  app.post("/api/alert-rules", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(buildErrorResponse("invalid_json", "Body is not valid JSON"), 400);
    }
    const parsed = alertRuleCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(buildErrorResponse("invalid_payload", formatZodError(parsed.error)), 400);
    }
    try {
      const rule = await insertAlertRule(parsed.data);
      return c.json({ api_id: newApiId(), ...rule }, 201);
    } catch (e) {
      console.error(`[alerts] create failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("create_failed", "Failed to create alert rule"), 500);
    }
  });

  app.get("/api/alert-rules/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      return c.json(buildErrorResponse("not_found", "Alert rule not found"), 404);
    }
    const rule = await getAlertRule(id);
    if (!rule) return c.json(buildErrorResponse("not_found", "Alert rule not found"), 404);
    return c.json({ api_id: newApiId(), ...rule });
  });

  app.patch("/api/alert-rules/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      return c.json(buildErrorResponse("not_found", "Alert rule not found"), 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(buildErrorResponse("invalid_json", "Body is not valid JSON"), 400);
    }
    const parsed = alertRulePatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(buildErrorResponse("invalid_payload", formatZodError(parsed.error)), 400);
    }
    try {
      const rule = await updateAlertRule(id, parsed.data);
      if (!rule) return c.json(buildErrorResponse("not_found", "Alert rule not found"), 404);
      return c.json({ api_id: newApiId(), ...rule });
    } catch (e) {
      console.error(`[alerts] update failed id=${id}: ${(e as Error).message}`);
      return c.json(buildErrorResponse("update_failed", "Failed to update alert rule"), 500);
    }
  });

  app.delete("/api/alert-rules/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      return c.json(buildErrorResponse("not_found", "Alert rule not found"), 404);
    }
    const deleted = await deleteAlertRule(id);
    if (!deleted) return c.json(buildErrorResponse("not_found", "Alert rule not found"), 404);
    return c.json({ api_id: newApiId(), deleted: true });
  });

  // ── Firings + delivery audit ─────────────────────────────────────────────

  app.get("/api/alert-rules/:id/firings", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      return c.json(buildErrorResponse("not_found", "Alert rule not found"), 404);
    }
    const limit = clampLimit(c.req.query("limit"));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    try {
      const { firings, totalCount } = await listFirings(id, limit, offset);
      return c.json(
        buildListResponse(firings, limit, offset, totalCount, `/api/alert-rules/${id}/firings`),
      );
    } catch (e) {
      console.error(`[alerts] firings list failed id=${id}: ${(e as Error).message}`);
      return c.json(buildErrorResponse("list_failed", "Failed to list firings"), 500);
    }
  });

  app.get("/api/alerts/webhook-attempts", async (c) => {
    const limit = clampLimit(c.req.query("limit"));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    const ruleId = c.req.query("rule_id") || null;
    if (ruleId && !UUID_RE.test(ruleId)) {
      return c.json(buildErrorResponse("invalid_payload", "rule_id must be a UUID"), 400);
    }
    try {
      const { attempts, totalCount } = await listWebhookAttempts(ruleId, limit, offset);
      return c.json(
        buildListResponse(attempts, limit, offset, totalCount, "/api/alerts/webhook-attempts"),
      );
    } catch (e) {
      console.error(`[alerts] attempts list failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("list_failed", "Failed to list webhook attempts"), 500);
    }
  });

  app.get("/api/alerts/webhook-stats", async (c) => {
    const rangeParam = c.req.query("range") ?? "7d";
    const range = ["24h", "7d", "30d"].includes(rangeParam) ? rangeParam : "7d";
    try {
      const stats = await getWebhookStats(range);
      return c.json({ api_id: newApiId(), range, ...stats });
    } catch (e) {
      console.error(`[alerts] webhook stats failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("stats_failed", "Failed to compute webhook stats"), 500);
    }
  });

  // ── Test send ────────────────────────────────────────────────────────────

  app.post("/api/alert-rules/:id/test", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      return c.json(buildErrorResponse("not_found", "Alert rule not found"), 404);
    }
    const rule = await getAlertRule(id);
    if (!rule) return c.json(buildErrorResponse("not_found", "Alert rule not found"), 404);
    const result = await deliverTest(rule);
    return c.json({
      api_id: newApiId(),
      ok: result.ok,
      response_status: result.status,
      error: result.error,
      duration_ms: result.durationMs,
    });
  });
}
