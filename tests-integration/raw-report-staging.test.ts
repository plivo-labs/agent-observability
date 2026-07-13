/**
 * Integration test for COR-02: OTLP raw_report patches that arrive BEFORE
 * the recording row must be parked in session_raw_report_patches and
 * replayed (not silently dropped) once insertSession creates the row.
 * This is a real-SQL behavior the mocked unit suite can't prove.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql, insertSession, drainStagedRawReportPatches, mergeSessionRawReport } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { describeDb } from "./helpers.js";

const RUN = `rrs-${Date.now().toString(36)}`;
const SESSION_ID = `${RUN}-sess`;

describeDb("OTLP-before-recording raw_report staging", () => {
  beforeAll(async () => {
    await migrate(sql);
  });

  afterAll(async () => {
    await sql`DELETE FROM session_raw_report_patches WHERE session_id LIKE ${RUN + "%"}`;
    await sql`DELETE FROM agent_transport_sessions WHERE session_id LIKE ${RUN + "%"}`;
  });

  test("a patch arriving before the row is staged, then replayed on drain", async () => {
    // 1. OTLP "session report" patch arrives first — no recording row yet.
    await mergeSessionRawReport({
      sessionId: SESSION_ID,
      patch: {
        usage: [{ type: "llm", model: "gpt-4o", prompt_tokens: 100, completion_tokens: 50 }],
        events: [{ kind: "function_call", name: "lookup" }],
      },
    });

    // It must be parked, not dropped, and must NOT have created a session.
    const staged = await sql`
      SELECT patch FROM session_raw_report_patches WHERE session_id = ${SESSION_ID}
    `;
    expect(staged).toHaveLength(1);
    const noRow = await sql`
      SELECT 1 FROM agent_transport_sessions WHERE session_id = ${SESSION_ID}
    `;
    expect(noRow).toHaveLength(0);

    // 2. The recording multipart finally creates the row (usage empty, as
    //    chat_history carries no token counts at insert time).
    await insertSession({
      sessionId: SESSION_ID,
      accountId: null,
      agentId: null,
      agentName: null,
      transport: null,
      startedAt: new Date(),
      endedAt: new Date(),
      durationMs: 1000,
      turnCount: 1,
      hasStt: true,
      hasLlm: true,
      hasTts: true,
      chatHistory: [],
      sessionMetrics: { per_turn: [], usage: null },
      rawReport: {},
      recordUrl: null,
    });

    // 3. Drain replays the parked patch.
    await drainStagedRawReportPatches(SESSION_ID);

    // The usage/cost/events from the early patch are now persisted, and the
    // staging row is gone.
    const [row] = await sql`
      SELECT session_metrics, raw_report
      FROM agent_transport_sessions WHERE session_id = ${SESSION_ID}
    `;
    const metrics = typeof row.session_metrics === "string"
      ? JSON.parse(row.session_metrics) : row.session_metrics;
    const rawReport = typeof row.raw_report === "string"
      ? JSON.parse(row.raw_report) : row.raw_report;
    expect(Array.isArray(metrics.usage)).toBe(true);
    expect(metrics.usage).toHaveLength(1);
    expect(rawReport.events).toHaveLength(1);

    const drained = await sql`
      SELECT 1 FROM session_raw_report_patches WHERE session_id = ${SESSION_ID}
    `;
    expect(drained).toHaveLength(0);
  });
});
