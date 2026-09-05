// Judge-registry API. Read covers the whole catalogue; writes are custom-only —
// the default judges are locked (403), enforced both here and in the db layer.
import type { Hono } from "hono";
import { buildErrorResponse, buildListResponse, formatZodError, newApiId, parseLimit } from "../response.js";
import { agentJudgesPutSchema, judgeCreateSchema, judgePatchSchema, judgeTestSchema } from "./schema.js";
import { getJudgeSpec } from "./db.js";
import { getSessionEvalSource } from "../evals-engine/db.js";
import { buildSessionEvalInput, type AgentConfig } from "../evals-engine/integration/session-evals.js";
import { eventsFromChatHistory } from "../evals-engine/eval-sweeper.js";
import { runCustomMetricJudges } from "../evals-engine/judges/custom-metric.js";
import {
  createCustomJudge,
  deleteCustomJudge,
  getJudge,
  JudgeNameConflictError,
  listAgentJudges,
  listJudges,
  setAgentJudges,
  UnknownJudgeIdsError,
  updateCustomJudge,
} from "./db.js";
import { customJudgeName, CUSTOM_JUDGE_NAME_RE } from "../evals-engine/judges/custom-metric.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = { fallback: 100, max: 200 };

export function registerJudgeRoutes(app: Hono): void {
  app.get("/api/judges", async (c) => {
    const limit = parseLimit(c.req.query("limit"), LIMIT);
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    const typeParam = c.req.query("type") ?? null;
    if (typeParam !== null && typeParam !== "default" && typeParam !== "custom") {
      return c.json(buildErrorResponse("invalid_payload", "type must be 'default' or 'custom'"), 400);
    }
    try {
      const { judges, totalCount } = await listJudges({ type: typeParam, limit, offset });
      const extraParams: Record<string, string> = typeParam ? { type: typeParam } : {};
      return c.json(buildListResponse(judges, limit, offset, totalCount, "/api/judges", extraParams));
    } catch (e) {
      console.error(`[judges] list failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("list_failed", "Failed to list judges"), 500);
    }
  });

  app.get("/api/judges/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json(buildErrorResponse("not_found", "No such judge"), 404);
    try {
      const judge = await getJudge(id);
      if (!judge) return c.json(buildErrorResponse("not_found", "No such judge"), 404);
      return c.json({ api_id: newApiId(), ...judge });
    } catch (e) {
      console.error(`[judges] get failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("db_error", "Failed to load judge"), 500);
    }
  });

  app.post("/api/judges", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(buildErrorResponse("invalid_json", "Body is not valid JSON"), 400);
    }
    const parsed = judgeCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(buildErrorResponse("invalid_payload", formatZodError(parsed.error)), 400);
    }
    const name = customJudgeName(parsed.data.display_name);
    if (!CUSTOM_JUDGE_NAME_RE.test(name)) {
      return c.json(
        buildErrorResponse("invalid_payload", "display_name must contain at least one letter or digit"),
        400,
      );
    }
    try {
      const judge = await createCustomJudge({ ...parsed.data, name });
      return c.json({ api_id: newApiId(), ...judge }, 201);
    } catch (e) {
      if (e instanceof JudgeNameConflictError) {
        return c.json(buildErrorResponse("name_conflict", `A judge named ${name} already exists`), 409);
      }
      console.error(`[judges] create failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("create_failed", "Failed to create judge"), 500);
    }
  });

  app.patch("/api/judges/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json(buildErrorResponse("not_found", "No such judge"), 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(buildErrorResponse("invalid_json", "Body is not valid JSON"), 400);
    }
    const parsed = judgePatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(buildErrorResponse("invalid_payload", formatZodError(parsed.error)), 400);
    }
    try {
      const updated = await updateCustomJudge(id, parsed.data);
      if (updated) return c.json({ api_id: newApiId(), ...updated });
      // Distinguish "locked default" from "gone" — a builder editing a default
      // by mistake needs to hear why, not chase a phantom 404.
      const existing = await getJudge(id);
      if (existing?.type === "default") {
        return c.json(
          buildErrorResponse("default_judge_immutable", "Default judges are read-only; create a custom judge instead"),
          403,
        );
      }
      return c.json(buildErrorResponse("not_found", "No such judge"), 404);
    } catch (e) {
      console.error(`[judges] update failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("update_failed", "Failed to update judge"), 500);
    }
  });

  app.delete("/api/judges/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json(buildErrorResponse("not_found", "No such judge"), 404);
    try {
      if (await deleteCustomJudge(id)) return c.json({ api_id: newApiId(), deleted: true });
      const existing = await getJudge(id);
      if (existing?.type === "default") {
        return c.json(
          buildErrorResponse("default_judge_immutable", "Default judges cannot be deleted"),
          403,
        );
      }
      return c.json(buildErrorResponse("not_found", "No such judge"), 404);
    } catch (e) {
      console.error(`[judges] delete failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("db_error", "Failed to delete judge"), 500);
    }
  });

  // ── dry-run test ───────────────────────────────────────────────────────────
  //
  // Runs ONE judge against already-ingested sessions and returns the verdicts
  // WITHOUT writing anything — no fan-out rows, no verdict blob. This is the
  // "Test metric" flow: judge a few recent calls before turning the metric on.
  // Works on drafts (enabled=false) deliberately — testing precedes enabling.
  app.post("/api/judges/:id/test", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json(buildErrorResponse("not_found", "No such judge"), 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(buildErrorResponse("invalid_json", "Body is not valid JSON"), 400);
    }
    const parsed = judgeTestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(buildErrorResponse("invalid_payload", formatZodError(parsed.error)), 400);
    }
    try {
      const spec = await getJudgeSpec(id);
      if (!spec) return c.json(buildErrorResponse("not_found", "No such LLM judge"), 404);

      const results = await Promise.all(
        parsed.data.session_ids.map(async (sessionId) => {
          const source = await getSessionEvalSource(sessionId);
          if (!source) {
            return { session_id: sessionId, verdict: null, reason: "session not found or has no agent config", available: false };
          }
          const events =
            Array.isArray((source.rawReport as any)?.events) && (source.rawReport as any).events.length > 0
              ? ((source.rawReport as any).events as any[])
              : eventsFromChatHistory(source.chatHistory);
          const { input, nodeRefs } = buildSessionEvalInput(source.config as AgentConfig, events);
          if (!input.full_transcript.trim()) {
            return { session_id: sessionId, verdict: null, reason: "no judgeable transcript", available: false };
          }
          if (source.transport) input.transport = source.transport;
          const [v] = await runCustomMetricJudges([spec], input, (nodeUuid) => {
            const i = input.nodes.findIndex((n) => n.node_uuid === nodeUuid);
            return nodeRefs[i]?.ref ?? "";
          });
          return {
            session_id: sessionId,
            verdict: v!.verdict,
            reason: v!.reason,
            technical_reason: v!.technical_reason,
            available: v!.available,
            ...(v!.per_node ? { per_node: v!.per_node } : {}),
          };
        }),
      );
      const decided = results.filter((r) => r.available);
      return c.json({
        api_id: newApiId(),
        judge_id: id,
        judge_name: spec.name,
        summary: {
          scored: decided.length,
          passed: decided.filter((r) => r.verdict === "pass").length,
          failed: decided.filter((r) => r.verdict === "fail").length,
          unknown: decided.filter((r) => r.verdict === "unknown").length,
        },
        results,
      });
    } catch (e) {
      console.error(`[judges] test failed judge=${id}: ${(e as Error).message}`);
      return c.json(buildErrorResponse("test_failed", "Failed to test judge"), 500);
    }
  });

  // ── agent ↔ judge mapping ──────────────────────────────────────────────────

  app.get("/api/agents/:agent_id/judges", async (c) => {
    const agentId = c.req.param("agent_id");
    try {
      const judges = await listAgentJudges(agentId);
      return c.json({ api_id: newApiId(), objects: judges });
    } catch (e) {
      console.error(`[judges] agent mapping list failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("list_failed", "Failed to list agent judges"), 500);
    }
  });

  app.put("/api/agents/:agent_id/judges", async (c) => {
    const agentId = c.req.param("agent_id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(buildErrorResponse("invalid_json", "Body is not valid JSON"), 400);
    }
    const parsed = agentJudgesPutSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(buildErrorResponse("invalid_payload", formatZodError(parsed.error)), 400);
    }
    // PUT semantics: the body is the agent's complete desired custom-judge set.
    const entries = parsed.data.judges.map((j) => ({ judge_id: j.judge_id, enabled: j.enabled ?? true }));
    const unique = new Set(entries.map((e) => e.judge_id));
    if (unique.size !== entries.length) {
      return c.json(buildErrorResponse("invalid_payload", "duplicate judge_id in judges"), 400);
    }
    try {
      const judges = await setAgentJudges(agentId, entries);
      return c.json({ api_id: newApiId(), objects: judges });
    } catch (e) {
      if (e instanceof UnknownJudgeIdsError) {
        return c.json(buildErrorResponse("invalid_payload", e.message), 400);
      }
      console.error(`[judges] agent mapping update failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("update_failed", "Failed to update agent judges"), 500);
    }
  });
}
