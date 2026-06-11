/**
 * Integration test for COR-05: at-least-once OTLP redelivery must not
 * duplicate evaluations or chat-item events. Both are real-SQL behaviors
 * (guarded INSERT / jsonb dedup) the mocked unit suite can't prove.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql, insertSession, insertLiveKitEvaluation, mergeSessionRawReport } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { describeDb } from "./helpers.js";

const RUN = `dedup-${Date.now().toString(36)}`;
const SESSION_ID = `${RUN}-sess`;

describeDb("OTLP redelivery dedup", () => {
  beforeAll(async () => {
    await migrate(sql);
    await insertSession({
      sessionId: SESSION_ID,
      accountId: RUN,
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
  });

  afterAll(async () => {
    await sql`DELETE FROM session_external_evals WHERE session_id LIKE ${RUN + "%"}`;
    await sql`DELETE FROM agent_transport_sessions WHERE session_id LIKE ${RUN + "%"}`;
  });

  test("a redelivered evaluation is inserted only once", async () => {
    const evalInput = {
      sessionId: SESSION_ID,
      source: "livekit_tagger",
      judgeName: "task_completion",
      tag: null,
      verdict: "pass",
      reasoning: "looks good",
      instructions: null,
      observedAt: new Date(),
      raw: { name: "task_completion", verdict: "pass", reasoning: "looks good" },
    };
    await insertLiveKitEvaluation(evalInput);
    await insertLiveKitEvaluation(evalInput); // redelivery — identical payload

    const rows = await sql`
      SELECT COUNT(*)::int AS n FROM session_external_evals
      WHERE session_id = ${SESSION_ID} AND judge_name = 'task_completion'
    `;
    expect(rows[0].n).toBe(1);

    // A genuinely different verdict is NOT deduped.
    await insertLiveKitEvaluation({
      ...evalInput,
      verdict: "fail",
      raw: { name: "task_completion", verdict: "fail", reasoning: "regressed" },
    });
    const after = await sql`
      SELECT COUNT(*)::int AS n FROM session_external_evals
      WHERE session_id = ${SESSION_ID} AND judge_name = 'task_completion'
    `;
    expect(after[0].n).toBe(2);
  });

  test("a redelivered chat-item event is appended only once", async () => {
    const event = {
      type: "conversation_item_added",
      created_at: 1700000000,
      item: { id: "item-xyz", role: "assistant", text: "hi" },
    };
    await mergeSessionRawReport({ sessionId: SESSION_ID, patch: { events: [event] } });
    await mergeSessionRawReport({ sessionId: SESSION_ID, patch: { events: [event] } }); // redelivery

    const [row] = await sql`
      SELECT raw_report FROM agent_transport_sessions WHERE session_id = ${SESSION_ID}
    `;
    const rawReport = typeof row.raw_report === "string" ? JSON.parse(row.raw_report) : row.raw_report;
    const matching = (rawReport.events ?? []).filter(
      (e: any) => e?.item?.id === "item-xyz",
    );
    expect(matching).toHaveLength(1);
  });
});
