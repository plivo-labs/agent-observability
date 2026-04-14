import { Hono } from "hono";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { serveStatic } from "hono/bun";
import { MetricsRecordingHeader } from "@livekit/protocol";
import { config, s3Enabled } from "./config.js";
import { uploadRecording } from "./s3.js";
import { sql, insertSession } from "./db.js";
import { migrate } from "./migrate.js";
import { verifyLivekitJwt } from "./auth.js";
import { parseChatHistory, normalizeKeys } from "./parse.js";
import { buildSessionMetrics } from "./metrics.js";

// Run migrations on startup if enabled
if (config.AUTO_MIGRATE) {
  await migrate(sql);
}

const app = new Hono();

app.use("*", requestId());
app.use("*", logger());

// ── Health check ────────────────────────────────────────────────────────────

app.get("/health", (c) => {
  return c.json({ status: "ok", s3Enabled });
});

// ── Session report endpoint ─────────────────────────────────────────────────

app.post("/observability/recordings/v0", async (c) => {
  const auth = await verifyLivekitJwt(
    c.req.header("Authorization"),
    config.LIVEKIT_API_KEY,
    config.LIVEKIT_API_SECRET
  );
  if (!auth.valid) {
    console.error("Auth failed:", auth.error);
    return c.json({ error: auth.error }, 401);
  }

  const formData = await c.req.formData();

  let sessionId = "";
  let startedAt: Date | null = null;
  let accountId: string | null = null;

  // Decode protobuf header
  const header = formData.get("header");
  if (header && header instanceof Blob) {
    const bytes = await header.arrayBuffer();
    try {
      const msg = MetricsRecordingHeader.fromBinary(new Uint8Array(bytes));
      sessionId = msg.roomId;
      const startSeconds = Number(msg.startTime?.seconds ?? 0n);
      const startNanos = msg.startTime?.nanos ?? 0;
      if (startSeconds > 0) {
        startedAt = new Date((startSeconds + startNanos / 1e9) * 1000);
      }
      accountId = msg.roomTags?.["account_id"] ?? null;
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
      startedAt,
      endedAt,
      durationMs,
      turnCount,
      hasStt,
      hasLlm,
      hasTts,
      chatHistory: chatItems,
      sessionMetrics: { per_turn: metrics, usage: normalizeKeys(rawReport?.usage) ?? null },
      recordUrl,
    });
    console.log(`Session saved: room_id=${sessionId} turns=${turnCount} duration=${durationMs}ms usage=${JSON.stringify(rawReport?.usage ?? 'none')}`);
  } catch (e) {
    console.error(`Failed to save session room_id=${sessionId}: ${(e as Error).message}`);
  }

  return c.json({ status: "ok" });
});

// ── REST API for the dashboard UI ───────────────────────────────────────────

app.get("/api/sessions", async (c) => {
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 50));
  const offset = (page - 1) * limit;
  const accountId = c.req.query("account_id") || null;

  let countResult;
  let rows;

  if (accountId) {
    [countResult] = await sql`SELECT count(*)::int as total FROM agent_transport_sessions WHERE account_id = ${accountId}`;
    rows = await sql`
      SELECT id, session_id, account_id, state, started_at, ended_at, duration_ms,
             turn_count, has_stt, has_llm, has_tts, record_url, created_at
      FROM agent_transport_sessions
      WHERE account_id = ${accountId}
      ORDER BY ended_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    [countResult] = await sql`SELECT count(*)::int as total FROM agent_transport_sessions`;
    rows = await sql`
      SELECT id, session_id, account_id, state, started_at, ended_at, duration_ms,
             turn_count, has_stt, has_llm, has_tts, record_url, created_at
      FROM agent_transport_sessions
      ORDER BY ended_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return c.json({
    data: rows,
    total: countResult.total,
    page,
    limit,
  });
});

app.get("/api/sessions/:id", async (c) => {
  const sessionId = c.req.param("id");
  const rows = await sql`
    SELECT id, session_id, account_id, state, started_at, ended_at, duration_ms,
           turn_count, has_stt, has_llm, has_tts,
           chat_history, session_metrics, record_url, created_at
    FROM agent_transport_sessions
    WHERE session_id = ${sessionId}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  const row = rows[0];
  const chatHistory = typeof row.chat_history === "string" ? JSON.parse(row.chat_history) : row.chat_history;
  const sessionMetrics = typeof row.session_metrics === "string" ? JSON.parse(row.session_metrics) : row.session_metrics;

  row.chat_history = chatHistory;
  row.session_metrics = buildSessionMetrics(chatHistory, sessionMetrics, row.turn_count);

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
