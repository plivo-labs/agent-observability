import { Hono } from "hono";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { MetricsRecordingHeader } from "@livekit/protocol";
import { config, s3Enabled } from "./config.js";
import { uploadRecording } from "./s3.js";
import { sql, insertSession } from "./db.js";
import { migrate } from "./migrate.js";
import { verifyLivekitJwt } from "./auth.js";
import { parseChatHistory } from "./parse.js";

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
    } catch {}
  }

  console.log(`Session report received: room_id=${sessionId}`);

  // Parse chat history
  let parsed = { chatItems: [] as any[], turnCount: 0, hasStt: false, hasLlm: false, hasTts: false, metrics: [] as any[] };

  const chatHistory = formData.get("chat_history");
  if (chatHistory && chatHistory instanceof Blob) {
    const text = await chatHistory.text();
    try {
      parsed = parseChatHistory(JSON.parse(text));
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
      startedAt,
      endedAt,
      durationMs,
      turnCount,
      hasStt,
      hasLlm,
      hasTts,
      chatHistory: chatItems,
      sessionMetrics: metrics,
      recordUrl,
    });
    console.log(`Session saved: room_id=${sessionId} turns=${turnCount} duration=${durationMs}ms`);
  } catch (e) {
    console.error(`Failed to save session room_id=${sessionId}: ${(e as Error).message}`);
  }

  return c.json({ status: "ok" });
});

export default {
  port: config.PORT,
  fetch: app.fetch,
};
