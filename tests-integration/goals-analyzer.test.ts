/**
 * End-to-end goal-analyzer sweep against real Postgres with an injected
 * MockLLM: seed → sweep → verdict rows + tracking; idempotent re-sweep;
 * failure marks attempts and a later sweep retries to success.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { MockLLM } from "../src/llm/mock.js";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { runGoalSweepOnce } from "../src/goals/analyzer.js";
import { describeDb, testRun } from "./helpers.js";

const t = testRun("gan");

const CHAT = [
  { type: "message", role: "user", content: ["I want to cancel my subscription."] },
  { type: "message", role: "assistant", content: "Cancelled it for you." },
];

describeDb("goal analyzer end to end", () => {
  beforeAll(async () => {
    await migrate(sql);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  test("sweep judges a goal-tagged session and a re-sweep is a no-op", async () => {
    const s = await t.seedSession({ accountId: t.uid("acct"), chatHistory: CHAT });
    await t.seedTag(s, "goal:cancellation:Cancel the subscription");
    const provider = new MockLLM([
      JSON.stringify({
        goals: [{ goal_name: "cancellation", achieved: true, reason: "Agent cancelled it.", technical_reason: "" }],
      }),
    ]);

    await runGoalSweepOnce({ provider });

    const rows = await sql`
      SELECT verdict, tag, instructions, reasoning FROM session_external_evals
      WHERE session_id = ${s} AND source = 'goal'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe("met");
    expect(rows[0].tag).toBe("cancellation");
    expect(rows[0].instructions).toBe("Cancel the subscription");

    const callsAfterFirst = provider.calls.length;
    await runGoalSweepOnce({ provider });
    // Session is 'done' → not re-claimed → no further LLM call.
    expect(provider.calls.length).toBe(callsAfterFirst);

    const dup = await sql`
      SELECT count(*)::int AS n FROM session_external_evals
      WHERE session_id = ${s} AND source = 'goal'
    `;
    expect(dup[0].n).toBe(1);
  });

  test("a failing model marks an attempt; a later sweep retries to success", async () => {
    const s = await t.seedSession({ accountId: t.uid("acct"), chatHistory: CHAT });
    await t.seedTag(s, "goal:retried:Be retried");
    // Three unparseable responses exhaust completeJSON's retries (1 call + 2
    // reprompts) → LlmError on the first sweep; the fourth (valid) is consumed
    // by the retry sweep.
    const provider = new MockLLM([
      "not json",
      "not json",
      "not json",
      JSON.stringify({
        goals: [{ goal_name: "retried", achieved: false, reason: "Nope.", technical_reason: "Caller hung up" }],
      }),
    ]);

    await runGoalSweepOnce({ provider });
    const [afterFail] = await sql`
      SELECT status, attempts FROM session_goal_analyses WHERE session_id = ${s}
    `;
    expect(afterFail.status).toBe("error");
    expect(afterFail.attempts).toBe(1);

    await runGoalSweepOnce({ provider });
    const [afterRetry] = await sql`
      SELECT status, attempts FROM session_goal_analyses WHERE session_id = ${s}
    `;
    expect(afterRetry.status).toBe("done");

    const rows = await sql`
      SELECT verdict, raw FROM session_external_evals
      WHERE session_id = ${s} AND source = 'goal'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe("unmet");
    expect(rows[0].raw.what_went_wrong).toBe("Caller hung up");
  });
});
