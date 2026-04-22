import type { Hono } from "hono";
import { evalPayloadV0Schema } from "./schema.js";
import {
  insertEvalRun,
  countEvalRuns,
  listEvalRuns,
  getEvalRun,
  listEvalCases,
  getEvalCase,
} from "./db.js";
import {
  buildListResponse,
  buildErrorResponse,
  newApiId,
} from "../response.js";

export function registerEvalRoutes(app: Hono) {
  // ── Ingest ───────────────────────────────────────────────────────────────

  app.post("/observability/evals/v0", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (e) {
      console.error(`[evals] invalid_json: ${(e as Error).message}`);
      return c.json(buildErrorResponse("invalid_json", "Body is not valid JSON"), 400);
    }

    const parsed = evalPayloadV0Schema.safeParse(body);
    if (!parsed.success) {
      const issues = (parsed.error as any).issues ?? [];
      const formatted = issues.slice(0, 10).map((i: any) => ({
        path: Array.isArray(i.path) ? i.path.join(".") : String(i.path ?? ""),
        code: i.code,
        message: i.message,
      }));
      console.error(
        `[evals] invalid_payload: ${formatted.length} issue(s)\n` +
          formatted
            .map((i: any) => `  • ${i.path || "<root>"}: ${i.message} (code=${i.code})`)
            .join("\n"),
      );
      return c.json(
        buildErrorResponse("invalid_payload", formatZodError(parsed.error)),
        400,
      );
    }

    const payload = parsed.data;
    console.log(
      `[evals] ingest run_id=${payload.run.run_id} agent=${payload.run.agent_id ?? "-"} framework=${payload.run.framework} cases=${payload.cases.length}`,
    );

    try {
      await insertEvalRun(payload);
    } catch (e) {
      console.error(
        `[evals] insert failed run_id=${payload.run.run_id}: ${(e as Error).message}`,
      );
      return c.json(
        buildErrorResponse("db_error", "Failed to persist eval run"),
        500,
      );
    }

    console.log(`[evals] saved run_id=${payload.run.run_id} cases=${payload.cases.length}`);
    return c.json(
      {
        api_id: newApiId(),
        run_id: payload.run.run_id,
        case_count: payload.cases.length,
      },
      201,
    );
  });

  // ── List ─────────────────────────────────────────────────────────────────

  app.get("/api/evals", async (c) => {
    const limit = Math.min(20, Math.max(1, Number(c.req.query("limit")) || 20));
    const offset = Math.max(0, Number(c.req.query("offset")) || 0);
    const accountId = c.req.query("account_id") || null;
    const agentId = c.req.query("agent_id") || null;
    const frameworkRaw = c.req.query("framework");
    const frameworks = frameworkRaw
      ? frameworkRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : null;
    const startedFrom = c.req.query("started_from") || null;
    const startedTo = c.req.query("started_to") || null;

    const extraParams: Record<string, string> = {};
    if (accountId) extraParams.account_id = accountId;
    if (agentId) extraParams.agent_id = agentId;
    if (frameworks && frameworks.length) extraParams.framework = frameworks.join(",");
    if (startedFrom) extraParams.started_from = startedFrom;
    if (startedTo) extraParams.started_to = startedTo;

    const opts = { limit, offset, accountId, agentId, frameworks, startedFrom, startedTo };
    const total = await countEvalRuns(opts);
    const rows = await listEvalRuns(opts);

    return c.json(
      buildListResponse(rows, limit, offset, total, "/api/evals", extraParams),
    );
  });

  // ── Run detail (includes cases) ──────────────────────────────────────────

  app.get("/api/evals/:run_id", async (c) => {
    const runId = c.req.param("run_id");
    const run = await getEvalRun(runId);
    if (!run) {
      return c.json(buildErrorResponse("not_found", "Eval run not found"), 404);
    }
    const cases = await listEvalCases(runId);
    return c.json({
      api_id: newApiId(),
      ...run,
      cases,
    });
  });

  // ── Case detail ──────────────────────────────────────────────────────────

  app.get("/api/evals/:run_id/cases/:case_id", async (c) => {
    const runId = c.req.param("run_id");
    const caseId = c.req.param("case_id");
    const evalCase = await getEvalCase(runId, caseId);
    if (!evalCase) {
      return c.json(buildErrorResponse("not_found", "Eval case not found"), 404);
    }
    return c.json({
      api_id: newApiId(),
      ...evalCase,
    });
  });
}

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
