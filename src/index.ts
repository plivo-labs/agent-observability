import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { serveStatic } from "hono/bun";
import { config, s3Enabled, basicAuthEnabled } from "./config.js";
import { uploadRecording } from "./s3.js";
import { sql, insertSession } from "./db.js";
import { migrate } from "./migrate.js";
import { parseChatHistory, normalizeKeys } from "./parse.js";
import { buildSessionMetrics } from "./metrics.js";
import { newApiId, buildListResponse, buildErrorResponse } from "./response.js";
import { registerEvalRoutes } from "./evals/routes.js";

// Run migrations on startup if enabled
if (config.AUTO_MIGRATE) {
  await migrate(sql);
}

const app = new Hono();

app.use("*", requestId());
app.use("*", logger());
app.use("/api/*", cors());

// Basic auth (all routes except /health, only when configured)
if (basicAuthEnabled) {
  const auth = basicAuth({
    username: config.AGENT_OBSERVABILITY_USER!,
    password: config.AGENT_OBSERVABILITY_PASS!,
  });
  app.use("/observability/*", auth);
  app.use("/api/*", auth);
}

// ── Health check ────────────────────────────────────────────────────────────

app.get("/health", (c) => {
  return c.json({ status: "ok", s3Enabled });
});

// ── Eval run endpoints (ingest + dashboard queries) ─────────────────────────

registerEvalRoutes(app);

// ── Session report endpoint ─────────────────────────────────────────────────

app.post("/observability/recordings/v0", async (c) => {
  // Auth is handled by middleware above

  const formData = await c.req.formData();

  let sessionId = "";
  let startedAt: Date | null = null;
  let accountId: string | null = null;
  let transport: string | null = null;

  // Decode JSON header
  const header = formData.get("header");
  if (header && header instanceof Blob) {
    try {
      const json = JSON.parse(await header.text());
      sessionId = json.session_id ?? "";
      const startTime = json.start_time ?? 0;
      if (startTime > 0) {
        startedAt = new Date(startTime * 1000);
      }
      accountId = json.room_tags?.account_id ?? null;
      transport = json.transport ?? null;
    } catch {}
  }

  console.log(`Session report received: room_id=${sessionId} account_id=${accountId}`);

  // Parse chat history
  let parsed = { chatItems: [] as any[], turnCount: 0, hasStt: false, hasLlm: false, hasTts: false, metrics: [] as any[] };
  let rawReport: any = null;

  const chatHistory = formData.get("chat_history");
  if (chatHistory && chatHistory instanceof Blob) {
    const text = await chatHistory.text();
    try {
      const raw = JSON.parse(text);
      parsed = parseChatHistory(raw);
      // parseChatHistory normalizes keys to snake_case — use the
      // normalized chatItems for storage. Keep raw for usage extraction.
      rawReport = raw;
    } catch {}
  }

  const { chatItems, turnCount, hasStt, hasLlm, hasTts, metrics } = parsed;

  // Handle audio recording
  let recordUrl: string | null = null;
  const audio = formData.get("audio");
  if (audio && audio instanceof Blob) {
    const bytes = await audio.arrayBuffer();

    if (s3Enabled) {
      try {
        const key = `recording_${sessionId || Date.now()}.ogg`;
        recordUrl = await uploadRecording(key, bytes);
      } catch (e) {
        console.error(`S3 upload failed for room_id=${sessionId}: ${(e as Error).message}`);
      }
    }
  }

  // Calculate duration
  const endedAt = new Date();
  let durationMs: number | null = null;
  if (startedAt) {
    durationMs = endedAt.getTime() - startedAt.getTime();
  }

  // Save to database
  try {
    await insertSession({
      sessionId,
      accountId,
      transport,
      startedAt,
      endedAt,
      durationMs,
      turnCount,
      hasStt,
      hasLlm,
      hasTts,
      chatHistory: chatItems,
      sessionMetrics: { per_turn: metrics, usage: normalizeKeys(rawReport?.usage) ?? null },
      rawReport: rawReport != null ? normalizeKeys(rawReport) : null,
      recordUrl,
    });
    console.log(`Session saved: room_id=${sessionId} turns=${turnCount} duration=${durationMs}ms usage=${JSON.stringify(rawReport?.usage ?? 'none')}`);
  } catch (e) {
    console.error(`Failed to save session room_id=${sessionId}: ${(e as Error).message}`);
  }

  return c.json({ api_id: newApiId(), message: "session report received" });
});

// ── REST API for the dashboard UI ───────────────────────────────────────────

app.get("/api/sessions", async (c) => {
  const limit = Math.min(20, Math.max(1, Number(c.req.query("limit")) || 20));
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const accountId = c.req.query("account_id") || null;
  const startedFrom = c.req.query("started_from") || null;
  const startedTo = c.req.query("started_to") || null;
  const transportRaw = c.req.query("transport");
  const transports = transportRaw
    ? transportRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const extraParams: Record<string, string> = {};
  if (accountId) extraParams.account_id = accountId;
  if (startedFrom) extraParams.started_from = startedFrom;
  if (startedTo) extraParams.started_to = startedTo;
  if (transports && transports.length) extraParams.transport = transports.join(",");

  const predicates: string[] = [];
  const params: unknown[] = [];
  if (accountId) {
    predicates.push(`account_id = $${params.length + 1}`);
    params.push(accountId);
  }
  if (startedFrom) {
    predicates.push(`started_at >= $${params.length + 1}`);
    params.push(startedFrom);
  }
  if (startedTo) {
    predicates.push(`started_at <= $${params.length + 1}`);
    params.push(startedTo);
  }
  if (transports && transports.length > 0) {
    const placeholders = transports.map((_, i) => `$${params.length + i + 1}`);
    predicates.push(`transport IN (${placeholders.join(", ")})`);
    params.push(...transports);
  }
  const whereClause = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";

  const [countResult] = await sql.unsafe(
    `SELECT count(*)::int as total FROM agent_transport_sessions ${whereClause}`,
    params,
  );

  const rows = await sql.unsafe(
    `SELECT id, session_id, account_id, transport, state, started_at, ended_at, duration_ms,
            turn_count, has_stt, has_llm, has_tts, record_url, created_at
     FROM agent_transport_sessions
     ${whereClause}
     ORDER BY ended_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  return c.json(buildListResponse(rows, limit, offset, countResult.total, "/api/sessions", extraParams));
});

app.get("/api/sessions/:id", async (c) => {
  const sessionId = c.req.param("id");
  const rows = await sql`
    SELECT id, session_id, account_id, transport, state, started_at, ended_at, duration_ms,
           turn_count, has_stt, has_llm, has_tts,
           chat_history, session_metrics, raw_report, record_url, created_at
    FROM agent_transport_sessions
    WHERE session_id = ${sessionId}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return c.json(buildErrorResponse("not_found", "Session not found"), 404);
  }

  const row = rows[0];
  const chatHistory = typeof row.chat_history === "string" ? JSON.parse(row.chat_history) : row.chat_history;
  const sessionMetrics = typeof row.session_metrics === "string" ? JSON.parse(row.session_metrics) : row.session_metrics;
  const rawReport = typeof row.raw_report === "string" ? JSON.parse(row.raw_report) : row.raw_report;

  row.chat_history = chatHistory;
  row.session_metrics = buildSessionMetrics(chatHistory, sessionMetrics, row.turn_count);
  row.raw_report = rawReport;
  row.events = rawReport?.events ?? null;
  row.options = rawReport?.options ?? null;
  row.api_id = newApiId();

  return c.json(row);
});

// ── Static file serving (production) ────────────────────────────────────────

if (process.env.NODE_ENV === "production") {
  app.use("/assets/*", serveStatic({ root: "./frontend/dist" }));
  app.use("/favicon*", serveStatic({ root: "./frontend/dist" }));
  app.get("*", serveStatic({ root: "./frontend/dist", path: "index.html" }));
}

export default {
  port: config.PORT,
  fetch: app.fetch,
};
