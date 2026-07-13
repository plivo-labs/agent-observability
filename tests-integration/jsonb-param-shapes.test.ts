/**
 * Regression suite for the 2026-07-13 bun-runtime jsonb corruption: bun:sql
 * 1.2.23 serialized JS ARRAYS bound to ::jsonb params as PG array literals,
 * storing invalid-JSON STRING scalars in chat_history (AO judging died on
 * read-back). All jsonb params now bind via jsonbParam() + ::text::jsonb —
 * Postgres parses the JSON, which is version-independent. These tests pin the
 * stored SHAPE (jsonb_typeof), not just round-trip equality, so a future
 * binding regression is caught even on a bun version where round-trip works.
 */
import { test, expect, afterAll } from "bun:test";
import { sql, insertSession } from "../src/db.js";
import { jsonbParam } from "../src/jsonb-param.js";
import { describeDb } from "./helpers.js";

const SID = "itest-jsonb-shape-0000000000000001";

afterAll(async () => {
  await sql`DELETE FROM ao_agent_transport_sessions WHERE session_id = ${SID}`;
});

describeDb("jsonb param binding shapes", () => {
  test("jsonbParam: null/undefined stay SQL NULL; values stringify", () => {
    expect(jsonbParam(null)).toBeNull();
    expect(jsonbParam(undefined)).toBeNull();
    expect(jsonbParam([1, 2])).toBe("[1,2]");
    expect(jsonbParam({ a: 1 })).toBe('{"a":1}');
  });

  test("insertSession stores chat_history as a jsonb ARRAY and null raw_report as SQL NULL", async () => {
    await sql`DELETE FROM ao_agent_transport_sessions WHERE session_id = ${SID}`;
    await insertSession({
      sessionId: SID,
      accountId: "itest",
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
      chatHistory: [
        { type: "message", role: "user", content: "hi" },
        { type: "message", role: "assistant", content: "hello" },
      ],
      sessionMetrics: { per_turn: [], usage: null },
      rawReport: null,
      recordUrl: null,
    });
    const [row] = await sql`
      SELECT jsonb_typeof(chat_history) AS chat_shape,
             jsonb_typeof(session_metrics) AS metrics_shape,
             raw_report IS NULL AS raw_is_sql_null
      FROM ao_agent_transport_sessions WHERE session_id = ${SID}
    `;
    // The 1.2.23 regression stored 'string' here — the judge reader then died
    // on JSON.parse and one poisoned row stalled every sweep.
    expect(row.chat_shape).toBe("array");
    expect(row.metrics_shape).toBe("object");
    expect(row.raw_is_sql_null).toBe(true);
  });
});
