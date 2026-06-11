/**
 * End-to-end goal-analyzer sweep against real Postgres with an injected
 * fake LLM: seed → sweep → verdict rows + tracking; idempotent re-sweep;
 * failure marks attempts and a later sweep retries to success.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { runGoalSweepOnce } from "../src/goals/analyzer.js";
import { describeDb, testRun } from "./helpers.js";

const t = testRun("gan");

const CHAT = [
  { type: "message", role: "user", content: ["I want to cancel my subscription."] },
  { type: "message", role: "assistant", content: "Cancelled it for you." },
];

function fakeJudge(payloads: Array<unknown | Error>) {
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const payload = payloads[Math.min(calls++, payloads.length - 1)];
      if (payload instanceof Error) throw payload;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        finishReason: "stop" as const,
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        warnings: [],
      };
    },
  });
  return { model, calls: () => calls };
}

describeDb("goal analyzer end to end", () => {
  beforeAll(async () => {
    await migrate(sql);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  test("sweep judges a goal-tagged session and a re-sweep is a no-op", async () => {
    const s = await t.seedSession({ accountId: t.uid("acct"), chatHistory: CHAT });
    await t.seedTag(s, "goal:Cancel the subscription");
    const judge = fakeJudge([
      { goals: [{ met: true, reasoning: "Agent cancelled it.", what_went_wrong: null }] },
    ]);

    await runGoalSweepOnce({ model: judge.model });

    const rows = await sql`
      SELECT verdict, instructions, reasoning FROM session_external_evals
      WHERE session_id = ${s} AND source = 'goal'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe("met");
    expect(rows[0].instructions).toBe("Cancel the subscription");

    const callsAfterFirst = judge.calls();
    await runGoalSweepOnce({ model: judge.model });
    expect(judge.calls()).toBe(callsAfterFirst);

    const dup = await sql`
      SELECT count(*)::int AS n FROM session_external_evals
      WHERE session_id = ${s} AND source = 'goal'
    `;
    expect(dup[0].n).toBe(1);
  });

  test("a failing model marks an attempt; a later sweep retries to success", async () => {
    const s = await t.seedSession({ accountId: t.uid("acct"), chatHistory: CHAT });
    await t.seedTag(s, "goal:Be retried");
    const judge = fakeJudge([
      new Error("rate limited"),
      { goals: [{ met: false, reasoning: "Nope.", what_went_wrong: "Caller hung up" }] },
    ]);

    await runGoalSweepOnce({ model: judge.model });
    const [afterFail] = await sql`
      SELECT status, attempts FROM session_goal_analyses WHERE session_id = ${s}
    `;
    expect(afterFail.status).toBe("error");
    expect(afterFail.attempts).toBe(1);

    await runGoalSweepOnce({ model: judge.model });
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
