// Calibrate reads the flagged call's transcript from AO's OWN store and feeds
// it to the rewrite. The unit suite mocks sql, so the ANY(::text[]) fetch and
// the transcript rendering are only proven here, against real Postgres.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { describeDb, testRun } from "./helpers.js";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { calibrateMetric, NoCalibrationTranscriptsError } from "../src/judges/ai-assist.js";
import { MockLLM } from "../src/llm/mock.js";

const t = testRun("ai-calibrate");
const sid = t.uid("sess");
const agentId = t.uid("agent");

describeDb("metric calibration (real PG)", () => {
  beforeAll(async () => {
    await migrate(sql);
    await t.seedAgent(agentId, t.run + "-acct");
    // A session whose transcript the rewrite must read.
    await sql`
      INSERT INTO ao_agent_transport_sessions
        (session_id, account_id, agent_id, started_at, ended_at, duration_ms, turn_count, chat_history, session_metrics, raw_report, transport)
      VALUES (${sid}, ${t.run + "-acct"}, ${agentId}, NOW() - interval '10 minutes', NOW() - interval '8 minutes', 60000, 2,
        ${JSON.stringify({
          items: [
            { type: "message", role: "assistant", content: "You're booked for Tuesday at 3pm." },
            { type: "message", role: "user", content: "Wait, you never confirmed my insurance." },
          ],
        })}::text::jsonb,
        '{}'::jsonb, NULL, 'livekit')
    `;
  });
  afterAll(async () => {
    await sql`DELETE FROM ao_agent_transport_sessions WHERE session_id = ${sid}`;
  });

  test("fetches the transcript by session_id and returns the refined description", async () => {
    // The MockLLM stands in for the model; the point is that the transcript was
    // fetched and handed in (no throw), and the refined text comes back.
    const llm = new MockLLM([
      JSON.stringify({ description: "Fail unless the agent confirmed insurance BEFORE offering any slot." }),
    ]);
    const out = await calibrateMetric(
      {
        name: "Insurance verified",
        description: "Fail if slots offered before verifying insurance.",
        scope: "conversation",
        examples: [{ session_id: sid, desired_verdict: "fail", reason: "slot offered with no insurance check" }],
      },
      llm,
    );
    expect(out.description).toContain("insurance");
  });

  test("throws NoCalibrationTranscriptsError when no flagged call has a transcript", async () => {
    const llm = new MockLLM([JSON.stringify({ description: "unused" })]);
    await expect(
      calibrateMetric(
        {
          description: "x",
          scope: "conversation",
          examples: [{ session_id: t.uid("missing"), desired_verdict: "pass" }],
        },
        llm,
      ),
    ).rejects.toBeInstanceOf(NoCalibrationTranscriptsError);
  });
});
