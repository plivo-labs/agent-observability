/**
 * 0.2 — recording ingest idempotency. A redelivered (byte-identical) recording
 * carries the same session_id; the UNIQUE constraint (migration 019) +
 * ON CONFLICT DO NOTHING must keep exactly one row AND must not clobber the
 * OTLP enrichment that lands on the row after the first insert.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sql, insertSession } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { describeDb } from "./helpers.js";

describeDb("recording upsert (session_id idempotency)", () => {
  const sessionId = `upsert-test-${Date.now().toString(36)}`;

  const base = {
    sessionId,
    accountId: "acct-upsert",
    agentId: null,
    agentName: null,
    transport: "livekit",
    startedAt: new Date(),
    endedAt: new Date(),
    durationMs: 1000,
    turnCount: 1,
    hasStt: true,
    hasLlm: true,
    hasTts: true,
    chatHistory: [] as unknown[],
    sessionMetrics: { per_turn: [] },
    rawReport: {},
    recordUrl: null,
  };

  beforeAll(async () => {
    await migrate(sql); // idempotent — ensures migration 019 is applied
    await sql`DELETE FROM agent_transport_sessions WHERE session_id = ${sessionId}`;
  });

  afterAll(async () => {
    await sql`DELETE FROM agent_transport_sessions WHERE session_id = ${sessionId}`;
  });

  test("redelivered recording → one row, enrichment preserved", async () => {
    await insertSession(base);

    // Simulate the OTLP "session report" patch back-filling token usage after
    // the recording landed.
    await sql`
      UPDATE agent_transport_sessions
      SET session_metrics = ${{ per_turn: [], usage: { total_tokens: 42 } }}::jsonb
      WHERE session_id = ${sessionId}
    `;

    // Retry: same session_id, original token-free payload.
    await insertSession(base);

    const rows = await sql`
      SELECT session_metrics FROM agent_transport_sessions WHERE session_id = ${sessionId}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].session_metrics?.usage?.total_tokens).toBe(42);
  });
});
