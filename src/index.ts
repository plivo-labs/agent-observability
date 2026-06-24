import { Hono } from "hono";
import type { Context } from "hono";
import { basicAuth } from "hono/basic-auth";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { serveStatic } from "hono/bun";
import { config, s3Enabled, basicAuthEnabled, liveKitAuthEnabled, dbConfigured } from "./config.js";
import { uploadRecording, deleteRecording } from "./s3.js";
import { sql, insertSession, applyStoredSessionTags, drainStagedRawReportPatches } from "./db.js";
import { upsertAgentTx } from "./agents/upsert.js";
import { migrate } from "./migrate.js";
import { parseChatHistory, normalizeKeys } from "./parse.js";
import { buildSessionMetrics } from "./metrics.js";
import { newApiId, buildListResponse, buildErrorResponse, escapeLikePattern, sanitizeForLog } from "./response.js";
import { registerEvalRoutes } from "./evals/routes.js";
import { registerAgentRoutes } from "./agents/routes.js";
import { registerAnalyticsRoutes } from "./analytics/routes.js";
import { sortSessionEvents } from "./events.js";
import { nativeLiveKitUploadAuth } from "./livekit/auth.js";
import { decodeMetricsRecordingHeader, decodeOtlpLogsRequest } from "./livekit/protobuf.js";
import { persistLiveKitOtlpLogs } from "./livekit/observability.js";
import { normalizeRawReport, parseJsonValue } from "./raw-report.js";
import { registerAlertRoutes } from "./alerts/routes.js";
import { startAlertSweeper, stopAlertSweeper } from "./alerts/sweeper.js";
import { registerSimulationRoutes } from "./sim-engine/routes.js";

// Run migrations on startup if enabled (skipped in stateless mode — no database).
if (config.AUTO_MIGRATE && dbConfigured) {
  await migrate(sql);
}

// Alert sweeper: windowed metric-threshold alert rules + webhook delivery
// retries. Runs inline by default so single-container deploys work with
// zero config; set ALERT_SWEEPER=off when running the dedicated worker
// entrypoint (src/worker.ts). Skipped under test — suites mock timers/DB.
// Gated on dbConfigured: the sweeper is entirely DB-backed, so it's inert in stateless mode.
if (process.env.NODE_ENV !== "test" && config.ALERT_SWEEPER === "inline" && dbConfigured) {
  startAlertSweeper();
}

// When neither auth mode is configured, every ingest route AND the whole
// dashboard API are open to anyone who can reach the port. That's a
// supported zero-config mode, but it must never be silent — an env-loading
// slip would otherwise expose all session data with no signal.
const authEnabled = basicAuthEnabled || liveKitAuthEnabled;
if (!authEnabled) {
  console.warn(
    "[security] No authentication configured — ingest and /api are OPEN to " +
      "anyone who can reach this port. Set AGENT_OBSERVABILITY_USER/_PASS or " +
      "the LiveKit API key pair to require credentials.",
  );
}

const app = new Hono();

app.use("*", requestId());
app.use("*", logger());
// Restrict cross-origin access to the dashboard API. Wildcard by default
// (zero-config local dev); set CORS_ALLOWED_ORIGINS to a comma-separated
// allow-list to lock it down. A wildcard already blocks credentialed
// cross-origin reads, but an explicit list is tighter when the dashboard
// is hosted on a known origin.
const corsOrigins = (config.CORS_ALLOWED_ORIGINS ?? "*").split(",").map((o) => o.trim()).filter(Boolean);
app.use("/api/*", cors({ origin: corsOrigins.length === 1 && corsOrigins[0] === "*" ? "*" : corsOrigins }));

// Basic auth (all routes except /health, only when configured)
if (basicAuthEnabled) {
  const auth = basicAuth({
    username: config.AGENT_OBSERVABILITY_USER!,
    password: config.AGENT_OBSERVABILITY_PASS!,
  });
  app.use("/observability/evals/*", auth);
  app.use("/api/*", auth);
}

// Cap ingest body sizes so a giant (or malicious) upload can't be buffered
// whole into memory. Recordings carry an audio OGG so they get a larger
// allowance than the OTLP log/trace/metric channels. bodyLimit returns 413
// once the limit is crossed.
const MB = 1024 * 1024;
const RECORDING_BODY_LIMIT = 100 * MB;
const OTLP_BODY_LIMIT = 16 * MB;
// Simulation generate/library requests carry a flow_json (no audio) — 10 MB is ample for a
// large flow while bounding a malicious/misconfigured oversized body (DoS guard).
const SIM_BODY_LIMIT = 10 * MB;
const tooLarge = (c: Context) =>
  c.json(buildErrorResponse("payload_too_large", "Request body exceeds the allowed size"), 413);

app.use("/observability/recordings/v0", bodyLimit({ maxSize: RECORDING_BODY_LIMIT, onError: tooLarge }));
app.use("/observability/logs/otlp/v0", bodyLimit({ maxSize: OTLP_BODY_LIMIT, onError: tooLarge }));
app.use("/observability/traces/otlp/v0", bodyLimit({ maxSize: OTLP_BODY_LIMIT, onError: tooLarge }));
app.use("/observability/metrics/otlp/v0", bodyLimit({ maxSize: OTLP_BODY_LIMIT, onError: tooLarge }));
// Cap simulation request bodies too (flow_json can be large but not unbounded). Registered
// before registerSimulationRoutes so it runs ahead of the /api/simulation handlers.
app.use("/api/simulation/*", bodyLimit({ maxSize: SIM_BODY_LIMIT, onError: tooLarge }));

app.use("/observability/recordings/v0", nativeLiveKitUploadAuth);
app.use("/observability/logs/otlp/v0", nativeLiveKitUploadAuth);
app.use("/observability/traces/otlp/v0", nativeLiveKitUploadAuth);
app.use("/observability/metrics/otlp/v0", nativeLiveKitUploadAuth);

// ── Health check ────────────────────────────────────────────────────────────

app.get("/health", (c) => {
  return c.json({ status: "ok", s3Enabled, authEnabled });
});

// ── Eval run endpoints (ingest + dashboard queries) ─────────────────────────

registerEvalRoutes(app);

// ── Agent endpoints (agent-oriented IA: virtual entity derived from
//    distinct agent_name across sessions + eval_runs) ─────────────────────────

registerAgentRoutes(app);

// ── Fleet analytics (cross-agent rollups for the /analytics page) ──────────

registerAnalyticsRoutes(app);

// ── Alert rules (windowed metric/count triggers + webhooks) ─────────────────

registerAlertRoutes(app);

// ── Simulation engine (scenario generation + scenario library CRUD) ──────────
//    Routes under /api/simulation; 404s when the engine is unconfigured (no
//    Redis). Registered after the /api/* auth middleware.

registerSimulationRoutes(app);

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

  console.log(`Session report received: room_id=${sanitizeForLog(sessionId)} account_id=${sanitizeForLog(accountId)}`);

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

  // Fallback: derive started_at from the earliest chat item when the
  // header didn't carry it. LiveKit's native MetricsRecordingHeader
  // (protobuf) leaves start_time unset for some flows — text-only
  // console mode is the one we've hit — and the multipart's chat
  // items always carry their own created_at (epoch seconds), so the
  // earliest one is a reliable lower bound. Without this fallback,
  // session.started_at stays NULL → duration_ms can't be computed
  // → Sessions table shows "—" for both Started and Duration on
  // every text-only session.
  if (!startedAt && chatItems.length > 0) {
    let firstTs = Infinity;
    for (const it of chatItems as any[]) {
      const n = Number(it.created_at);
      if (Number.isFinite(n) && n > 0 && n < firstTs) firstTs = n;
    }
    if (Number.isFinite(firstTs)) {
      startedAt = new Date(firstTs * 1000);
    }
  }

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

  // agent_id extraction. Two places it can live in the multipart
  // payload, tried in order:
  //   1. raw_report.agent_id  — if the SDK puts it at the top level.
  //   2. raw_report.tags[]    — the SDK's tagger emits "agent_id:<uuid>"
  //                             as a session tag; the tags array lands
  //                             in raw_report verbatim.
  // The column is NOT NULL (migration 011); pre-empt missing values
  // with a clean 400 here rather than waiting for a 500 from INSERT.
  //
  // Only enforced when raw_report is present — partial uploads that
  // only carry header+audio (no chat_history blob) fall through to
  // insertSession with agent_id=null and will fail at the DB layer.
  // Header-only requests are abnormal in production but appear in
  // tests and aren't worth blocking here.
  const extractAgentId = (rr: any): string | null => {
    if (typeof rr?.agent_id === "string" && rr.agent_id.length > 0) {
      return rr.agent_id;
    }
    if (Array.isArray(rr?.tags)) {
      for (const tag of rr.tags) {
        if (typeof tag === "string" && tag.startsWith("agent_id:")) {
          const v = tag.slice("agent_id:".length);
          if (v.length > 0) return v;
        }
      }
    }
    return null;
  };
  // Mirror of extractAgentId for account_id. The SDK's _ensure_transport_tags
  // attaches `account_id:<value>` to tagger.tags, which arrives in the
  // multipart's chat_history JSON via the to_dict monkey-patch.
  const extractAccountId = (rr: any): string | null => {
    if (typeof rr?.account_id === "string" && rr.account_id.length > 0) {
      return rr.account_id;
    }
    if (Array.isArray(rr?.tags)) {
      for (const tag of rr.tags) {
        if (typeof tag === "string" && tag.startsWith("account_id:")) {
          const v = tag.slice("account_id:".length);
          if (v.length > 0) return v;
        }
      }
    }
    return null;
  };
  // Prefer header's account_id; fall back to rawReport.tags so the
  // multipart's tagger-sourced tags are honored when the header didn't
  // carry the value.
  if (!accountId) {
    accountId = extractAccountId(rawReport);
  }
  // agent_id is optional at multipart ingest time.
  //
  // The agent-transport SDK injects it into chat_history JSON (top-level
  // agent_id field + a "agent_id:<uuid>" entry in tags[]) so it lands
  // here on the first request. Raw-LiveKit uploads via
  // _upload_session_report carry a vanilla ChatContext.to_dict() that
  // is items-only and won't have it — for those, the OTLP "tag" body
  // arrives ~1s later carrying `agent_id:<uuid>` and applySessionTagMetadata
  // backfills the column via UPDATE keyed on session_id. Same pattern
  // account_id already follows (migration 002 made that column
  // nullable from the start).
  //
  // We log when it's missing so the gap is visible — easier to spot a
  // worker that never emits the OTLP channel at all (e.g., misconfigured
  // observability URL).
  const agentId = extractAgentId(rawReport);
  if (rawReport != null && !agentId) {
    console.warn(
      `[recordings] agent_id not in chat_history; expecting OTLP tag backfill for session=${sessionId}`,
    );
  }

  const agentNameFromReport =
    typeof rawReport?.agent_name === "string" && rawReport.agent_name.length > 0
      ? rawReport.agent_name
      : null;

  // Save to database. Agent upsert and session insert share one
  // transaction so a session insert failure can't leave an orphan agent
  // row (the FK on agent_transport_sessions.agent_id otherwise tempts
  // exactly that race).
  try {
    await sql.begin(async (tx: any) => {
      if (agentId) {
        await upsertAgentTx(tx, { agentId, accountId, agentName: agentNameFromReport });
      }
      await insertSession({
        sessionId,
        accountId,
        agentId,
        agentName: agentNameFromReport,
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
      }, tx);
    });
    if (sessionId) {
      await applyStoredSessionTags(sessionId);
      // Replay any OTLP raw_report patches that beat this recording row.
      await drainStagedRawReportPatches(sessionId);
    }
    console.log(`Session saved: room_id=${sanitizeForLog(sessionId)} turns=${turnCount} duration=${durationMs}ms usage=${JSON.stringify(rawReport?.usage ?? 'none')}`);
  } catch (e) {
    // Return a non-2xx so the SDK's at-least-once delivery retries. A 200
    // here would make the SDK treat the report as durably stored and drop
    // it — permanent data loss on any transient DB error.
    console.error(`Failed to save session room_id=${sessionId}: ${(e as Error).message}`);
    return c.json(
      buildErrorResponse("session_save_failed", "Failed to persist session report"),
      503,
    );
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

/** ts_headline() options for /api/sessions match snippets. StartSel/StopSel
 * are control characters — they cannot occur in spoken transcript text, and
 * the dashboard splits on them to render <mark> spans (never raw HTML).
 * Two ~12-word fragments, joined with " … ".
 * Mirrored verbatim in tests-integration/transcript-search.test.ts. */
const TS_HEADLINE_OPTIONS =
  'StartSel=\u0001, StopSel=\u0002, MaxFragments=2, MaxWords=12, MinWords=6, FragmentDelimiter=" … "';

app.get("/api/sessions", async (c) => {
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20));
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const accountId = c.req.query("account_id") || null;
  const agentId = c.req.query("agent_id") || null;
  const agentName = c.req.query("agent_name") || null;
  const startedFrom = c.req.query("started_from") || null;
  const startedTo = c.req.query("started_to") || null;
  const transportRaw = c.req.query("transport");
  const transports = transportRaw
    ? transportRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const q = (c.req.query("q") || "").trim();

  const extraParams: Record<string, string> = {};
  if (q) extraParams.q = q;
  if (accountId) extraParams.account_id = accountId;
  if (agentId) extraParams.agent_id = agentId;
  if (agentName) extraParams.agent_name = agentName;
  if (startedFrom) extraParams.started_from = startedFrom;
  if (startedTo) extraParams.started_to = startedTo;
  if (transports && transports.length) extraParams.transport = transports.join(",");

  const predicates: string[] = [];
  const params: unknown[] = [];
  if (q) {
    // Full-text word search over the flattened transcript (migration 018).
    // The expression must stay textually identical to the GIN index
    // expression or the planner falls back to a sequential scan. The raw
    // user string binds directly: websearch_to_tsquery never throws on
    // malformed input, and its web-search syntax ("phrase", -exclude, or)
    // is intentionally exposed to users.
    predicates.push(
      `to_tsvector('english', transcript_text) @@ websearch_to_tsquery('english', $${params.length + 1})`,
    );
    params.push(q);
  }
  if (accountId) {
    // Case-insensitive substring match. The user-typed value is escaped
    // for LIKE metacharacters and lower-cased once in JS so the SQL can
    // pattern-match against `LOWER(account_id)` without a runtime
    // `LOWER` on the constant. Trades the existing btree index for a
    // sequential scan — fine at current volumes; revisit with a
    // pg_trgm GIN index if filter latency starts mattering.
    predicates.push(`LOWER(account_id) LIKE $${params.length + 1}`);
    params.push(`%${escapeLikePattern(accountId.toLowerCase())}%`);
  }
  if (agentId) {
    // Exact match: agent_id is the primary identifier — comes from the
    // agent dashboard URL param. The btree index serves this.
    predicates.push(`agent_id = $${params.length + 1}`);
    params.push(agentId);
  }
  if (agentName) {
    // Exact match too, for the case where the URL is built off the
    // legacy agent_name path. Used for pre-agent_id sessions.
    predicates.push(`agent_name = $${params.length + 1}`);
    params.push(agentName);
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

  // Match excerpt for an active transcript search: ts_headline() reuses the
  // exact tsquery the predicate used, so stemming, quoted phrases, and
  // -exclusions agree with the filter by construction. It runs only on the
  // returned page — the GIN-indexed predicate narrowed the set first. $1 is
  // always the q param because the q predicate is pushed first above.
  const rowsParams: unknown[] = [...params, limit, offset];
  let snippetCol = "";
  if (q) {
    snippetCol = `, ts_headline('english', transcript_text, websearch_to_tsquery('english', $1), $${rowsParams.length + 1}) AS match_snippet`;
    rowsParams.push(TS_HEADLINE_OPTIONS);
  }

  const rows = await sql.unsafe(
    `SELECT id, session_id, account_id, agent_id, agent_name, transport, state, started_at, ended_at, duration_ms,
            turn_count, has_stt, has_llm, has_tts, record_url, created_at${snippetCol}
     FROM agent_transport_sessions
     ${whereClause}
     ORDER BY ended_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    rowsParams,
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

  // Clean up each deleted session's audio so recordings don't outlive the
  // row (orphaned objects = retention/privacy gap). Best-effort and
  // post-commit: a failed S3 delete must not fail the API delete. The key
  // is reconstructed deterministically from the session id (matching the
  // upload key) so we don't need to parse the stored URL.
  if (s3Enabled) {
    await Promise.all(
      (deleted as Array<{ session_id: string }>).map((row) =>
        deleteRecording(`recording_${row.session_id}.ogg`).catch((e) =>
          console.error(
            `[s3] failed to delete recording for session=${sanitizeForLog(row.session_id)}: ${(e as Error).message}`,
          ),
        ),
      ),
    );
  }

  return c.json({ api_id: newApiId(), deleted: deleted.length });
});

app.get("/api/sessions/:id", async (c) => {
  const sessionId = c.req.param("id");
  const rows = await sql`
    SELECT id, session_id, account_id, agent_id, agent_name, transport, state, started_at, ended_at, duration_ms,
           turn_count, has_stt, has_llm, has_tts,
           chat_history, session_metrics, raw_report, record_url, estimated_cost_usd, created_at
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

  // Usage fallback: native LiveKit uploads land via two separate POSTs
  // — the recording multipart creates the row with whatever usage was
  // in the chat_history JSON (often missing), and the OTLP session-
  // report log adds the real usage to raw_report afterward. Front-fill
  // session_metrics.usage from raw_report.usage so the read path always
  // has the merged view, even for rows where the OTLP merge happened
  // after the initial insert.
  if (
    sessionMetrics &&
    !Array.isArray(sessionMetrics) &&
    (sessionMetrics.usage == null || (Array.isArray(sessionMetrics.usage) && sessionMetrics.usage.length === 0)) &&
    Array.isArray(rawReport?.usage) &&
    rawReport.usage.length > 0
  ) {
    sessionMetrics.usage = rawReport.usage;
  }

  row.chat_history = chatHistory;
  row.session_metrics = buildSessionMetrics(chatHistory, sessionMetrics, row.turn_count, {
    durationMs: row.duration_ms,
    startedAt: row.started_at,
  });
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

const serveConfig = {
  port: config.PORT,
  fetch: app.fetch,
};

// Run as the entrypoint: serve explicitly so SIGTERM/SIGINT can stop
// intake and drain in-flight requests before the process exits.
if (import.meta.main) {
  const server = Bun.serve(serveConfig);
  console.log(`API listening on :${server.port}`);

  const shutdown = async (signal: string) => {
    console.log(`[api] ${signal} received — draining connections`);
    stopAlertSweeper();
    await server.stop(); // stop intake, wait for in-flight requests
    await (sql as any).close?.();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Tests import this and call .fetch directly. When the file IS the
// entrypoint the default export must not look like a server config —
// Bun would auto-serve it and collide with the explicit Bun.serve above.
export default import.meta.main ? undefined : serveConfig;
