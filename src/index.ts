import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { serveStatic } from "hono/bun";
import { config, s3Enabled, basicAuthEnabled } from "./config.js";
import { uploadRecording } from "./s3.js";
import { sql, insertSession, applyStoredSessionTags } from "./db.js";
import { migrate } from "./migrate.js";
import { parseChatHistory, normalizeKeys } from "./parse.js";
import { buildSessionMetrics } from "./metrics.js";
import { newApiId, buildListResponse, buildErrorResponse, escapeLikePattern } from "./response.js";
import { registerEvalRoutes } from "./evals/routes.js";
import { registerSimulationRoutes } from "./simulation/routes.js";
import { registerLibraryRoutes } from "./simulation/library.js";
import { registerScheduleRoutes, startScheduler } from "./simulation/schedules.js";
import { sortSessionEvents } from "./events.js";
import { nativeLiveKitUploadAuth } from "./livekit/auth.js";
import { decodeMetricsRecordingHeader, decodeOtlpLogsRequest } from "./livekit/protobuf.js";
import { persistLiveKitOtlpLogs } from "./livekit/observability.js";
import { normalizeRawReport, parseJsonValue } from "./raw-report.js";

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
  app.use("/observability/evals/*", auth);
  app.use("/api/*", auth);
}

app.use("/observability/recordings/v0", nativeLiveKitUploadAuth);
app.use("/observability/logs/otlp/v0", nativeLiveKitUploadAuth);
app.use("/observability/traces/otlp/v0", nativeLiveKitUploadAuth);
app.use("/observability/metrics/otlp/v0", nativeLiveKitUploadAuth);

// ── Health check ────────────────────────────────────────────────────────────

app.get("/health", (c) => {
  return c.json({ status: "ok", s3Enabled });
});

// ── Eval run endpoints (ingest + dashboard queries) ─────────────────────────

registerEvalRoutes(app);

// ── Simulation endpoints (run a persona sweep against a prompt) ──────────────

registerSimulationRoutes(app);
registerLibraryRoutes(app);
registerScheduleRoutes(app);
startScheduler();

// ── Session report endpoint ─────────────────────────────────────────────────

app.post("/observability/recordings/v0", async (c) => {
  // Auth is handled by middleware above. Native LiveKit uploads use Bearer
  // JWTs; Basic remains accepted here for the legacy JSON-header uploader.

  const formData = await c.req.formData();

  let sessionId = "";
  let startedAt: Date | null = null;
  let accountId: string | null = null;
  let transport: string | null = null;

  // Decode either the legacy JSON header or LiveKit's native protobuf
  // MetricsRecordingHeader.
  const header = formData.get("header");
  if (header && header instanceof Blob) {
    const headerBytes = new Uint8Array(await header.arrayBuffer());
    try {
      const headerText = new TextDecoder().decode(headerBytes);
      const json = JSON.parse(headerText);
      sessionId = json.session_id ?? "";
      const startTime = json.start_time ?? 0;
      if (startTime > 0) {
        startedAt = new Date(startTime * 1000);
      }
      accountId = json.room_tags?.account_id ?? null;
      transport = json.transport ?? null;
    } catch {
      try {
        const decoded = decodeMetricsRecordingHeader(headerBytes);
        sessionId = decoded.roomId;
        startedAt = decoded.startedAt;
        accountId = decoded.roomTags.account_id ?? null;
        transport = decoded.roomTags.transport ?? null;
      } catch {}
    }
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
      rawReport: rawReport != null ? normalizeRawReport(normalizeKeys(rawReport)) : null,
      recordUrl,
    });
    if (sessionId) {
      await applyStoredSessionTags(sessionId);
    }
    console.log(`Session saved: room_id=${sessionId} turns=${turnCount} duration=${durationMs}ms usage=${JSON.stringify(rawReport?.usage ?? 'none')}`);
  } catch (e) {
    console.error(`Failed to save session room_id=${sessionId}: ${(e as Error).message}`);
  }

  return c.json({ api_id: newApiId(), message: "session report received" });
});

// ── Native LiveKit OTLP endpoints ───────────────────────────────────────────

app.post("/observability/logs/otlp/v0", async (c) => {
  try {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const logs = decodeOtlpLogsRequest(
      bytes,
      c.req.header("content-encoding"),
      c.req.header("content-type"),
    );
    const persisted = await persistLiveKitOtlpLogs(logs);
    return c.json({ api_id: newApiId(), accepted: logs.length, ...persisted });
  } catch (e) {
    console.error(`Failed to ingest LiveKit OTLP logs: ${(e as Error).message}`);
    return c.json(buildErrorResponse("invalid_otlp_logs", "Could not decode OTLP logs payload"), 400);
  }
});

app.post("/observability/traces/otlp/v0", async (c) => {
  await c.req.arrayBuffer();
  return c.body(null, 200);
});

app.post("/observability/metrics/otlp/v0", async (c) => {
  await c.req.arrayBuffer();
  return c.body(null, 200);
});

// ── REST API for the dashboard UI ───────────────────────────────────────────

app.get("/api/sessions", async (c) => {
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20));
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
    // Case-insensitive substring match. The user-typed value is escaped
    // for LIKE metacharacters and lower-cased once in JS so the SQL can
    // pattern-match against `LOWER(account_id)`/`LOWER(session_id)`
    // without a runtime `LOWER` on the constant. Matches EITHER column
    // (account OR session id), reusing the same single param. Trades
    // the existing btree index for a sequential scan — fine at current
    // volumes; revisit with a pg_trgm GIN index if filter latency
    // starts mattering.
    predicates.push(
      `(LOWER(account_id) LIKE $${params.length + 1} OR LOWER(session_id) LIKE $${params.length + 1})`,
    );
    params.push(`%${escapeLikePattern(accountId.toLowerCase())}%`);
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

app.delete("/api/sessions", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(buildErrorResponse("invalid_json", "Body is not valid JSON"), 400);
  }
  const sessionIds = (body as { session_ids?: unknown })?.session_ids;
  if (
    !Array.isArray(sessionIds) ||
    sessionIds.length === 0 ||
    !sessionIds.every((s) => typeof s === "string" && s.length > 0)
  ) {
    return c.json(
      buildErrorResponse("invalid_payload", "session_ids must be a non-empty array of strings"),
      400,
    );
  }
  // Cap each request to a reasonable batch size so a single call can't
  // wipe the table by accident or balloon the parameter array.
  if (sessionIds.length > 200) {
    return c.json(
      buildErrorResponse("too_many", "Cannot delete more than 200 sessions at once"),
      400,
    );
  }
  // Bun's `sql\`...\`` template stringifies a JS array as a CSV — Postgres
  // then complains the value isn't a valid array literal. Build positional
  // placeholders via `sql.unsafe` instead, matching the listing endpoints.
  const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(", ");
  const deleted = await sql.unsafe(
    `DELETE FROM agent_transport_sessions
     WHERE session_id IN (${placeholders})
     RETURNING session_id`,
    sessionIds,
  );
  return c.json({ api_id: newApiId(), deleted: deleted.length });
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

  const [tagRows, evaluationRows, outcomeRows] = await Promise.all([
    sql`
      SELECT name, metadata, source, observed_at, created_at, updated_at
      FROM session_tags
      WHERE session_id = ${sessionId}
      ORDER BY COALESCE(observed_at, created_at) ASC, name ASC
    `,
    sql`
      SELECT source, judge_name, tag, verdict, reasoning, instructions, observed_at, raw, created_at
      FROM session_external_evals
      WHERE session_id = ${sessionId}
      ORDER BY COALESCE(observed_at, created_at) ASC, id ASC
    `,
    sql`
      SELECT source, outcome, reason, observed_at, raw, created_at, updated_at
      FROM session_outcomes
      WHERE session_id = ${sessionId}
      ORDER BY COALESCE(observed_at, updated_at, created_at) DESC
      LIMIT 1
    `,
  ]);

  const row = rows[0];
  const chatHistory = parseJsonValue(row.chat_history);
  const sessionMetrics = parseJsonValue(row.session_metrics);
  const rawReport = normalizeRawReport(row.raw_report);

  row.chat_history = chatHistory;
  row.session_metrics = buildSessionMetrics(chatHistory, sessionMetrics, row.turn_count);
  row.raw_report = rawReport;
  row.events = sortSessionEvents(rawReport?.events ?? null);
  row.options = rawReport?.options ?? null;
  row.tags = (tagRows ?? []).map((tag: any) => ({
    ...tag,
    metadata: typeof tag.metadata === "string" ? JSON.parse(tag.metadata) : tag.metadata,
  }));
  row.evaluations = (evaluationRows ?? []).map((evaluation: any) => ({
    ...evaluation,
    raw: typeof evaluation.raw === "string" ? JSON.parse(evaluation.raw) : evaluation.raw,
  }));
  row.outcome = outcomeRows?.[0]
    ? {
        ...outcomeRows[0],
        raw: typeof outcomeRows[0].raw === "string" ? JSON.parse(outcomeRows[0].raw) : outcomeRows[0].raw,
      }
    : null;
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
