/**
 * Integration tests for the goal analyzer's db layer (migration 019):
 * candidate discovery across BOTH tag sources (session_tags for the OTLP
 * path, raw_report.tags for the recording path), the atomic claim
 * protocol (fresh claims block, stale claims reclaim), completion, and
 * the error/attempt-cap bookkeeping. All of this lives in SQL — real
 * Postgres only.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import {
  claimGoalSessions,
  loadGoalSession,
  completeGoalAnalysis,
  markGoalAnalysisError,
} from "../src/goals/db.js";
import { listGoalResults } from "../src/agents/db.js";
import { describeDb, testRun } from "./helpers.js";

const t = testRun("gdb");

const CHAT = [
  { type: "message", role: "user", content: ["Hello, I need help with my order."] },
  { type: "message", role: "assistant", content: ["Happy to help."] },
];

/** Claim broadly, keep only this run's sessions. */
async function claimOurs(limit = 50): Promise<string[]> {
  const ids = await claimGoalSessions(limit);
  return ids.filter((id) => id.startsWith(t.run));
}

describeDb("goal analysis db layer", () => {
  beforeAll(async () => {
    await migrate(sql);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  test("claims sessions with OTLP-path goal tags; skips sessions without goals", async () => {
    const withGoal = await t.seedSession({ accountId: t.uid("acct"), chatHistory: CHAT });
    await t.seedTag(withGoal, "goal:order-issue:Resolve the order issue");
    const withoutGoal = await t.seedSession({ accountId: t.uid("acct"), chatHistory: CHAT });

    const claimed = await claimOurs();
    expect(claimed).toContain(withGoal);
    expect(claimed).not.toContain(withoutGoal);
  });

  test("claims sessions whose goals arrived via raw_report tags (recording path)", async () => {
    const s = await t.seedSession({
      accountId: t.uid("acct"),
      chatHistory: CHAT,
      rawReport: { tags: ["goal:identity:Confirm identity", "account_id:acct-x"] },
    });
    const claimed = await claimOurs();
    expect(claimed).toContain(s);
  });

  test("skips goal sessions without a transcript", async () => {
    const empty = await t.seedSession({ accountId: t.uid("acct"), chatHistory: [] });
    await t.seedTag(empty, "goal:anything");
    const nul = await t.seedSession({ accountId: t.uid("acct"), chatHistory: null });
    await t.seedTag(nul, "goal:anything");

    const claimed = await claimOurs();
    expect(claimed).not.toContain(empty);
    expect(claimed).not.toContain(nul);
  });

  test("a fresh claim blocks re-claiming; a stale claim is reclaimable", async () => {
    const s = await t.seedSession({ accountId: t.uid("acct"), chatHistory: CHAT });
    await t.seedTag(s, "goal:stay-claimed");
    const first = await claimOurs();
    expect(first).toContain(s);

    // Immediately after: claimed_at is fresh — not eligible.
    expect(await claimOurs()).not.toContain(s);

    // Back-date the claim beyond the 10-minute staleness window.
    await sql`
      UPDATE session_goal_analyses
      SET claimed_at = NOW() - interval '11 minutes'
      WHERE session_id = ${s}
    `;
    expect(await claimOurs()).toContain(s);
  });

  test("respects the batch limit", async () => {
    for (let i = 0; i < 3; i++) {
      const s = await t.seedSession({ accountId: t.uid("acct"), chatHistory: CHAT });
      await t.seedTag(s, "goal:batchy");
    }
    const claimed = await claimGoalSessions(2);
    expect(claimed.length).toBeLessThanOrEqual(2);
  });

  test("loadGoalSession merges both tag sources, strips prefixes, dedupes", async () => {
    const s = await t.seedSession({
      accountId: t.uid("acct"),
      chatHistory: CHAT,
      rawReport: { tags: ["goal:from-recording:Recording goal", "goal:shared:Recording wording"] },
    });
    await t.seedTag(s, "goal:from-otlp:Otlp goal");
    await t.seedTag(s, "goal:shared:Otlp wording");

    const { goals, chatHistory } = await loadGoalSession(s);
    expect(goals.map((g) => g.name).sort()).toEqual(["from-otlp", "from-recording", "shared"].sort());
    // Dedupe is by NAME; the first-seen description wins (otlp source is read first).
    expect(goals.find((g) => g.name === "shared")?.description).toBe("Otlp wording");
    expect(goals.find((g) => g.name === "from-recording")?.description).toBe("Recording goal");
    expect(Array.isArray(chatHistory)).toBe(true);
  });

  test("completeGoalAnalysis writes one verdict row per goal and stops re-claims", async () => {
    const s = await t.seedSession({ accountId: t.uid("acct"), chatHistory: CHAT });
    await t.seedTag(s, "goal:met-goal:The met goal");
    await t.seedTag(s, "goal:unmet-goal:The unmet goal");
    expect(await claimOurs()).toContain(s);

    await completeGoalAnalysis(s, [
      { name: "met-goal", description: "The met goal", met: true, reasoning: "Did it", whatWentWrong: null },
      { name: "unmet-goal", description: "The unmet goal", met: false, reasoning: "Did not", whatWentWrong: "Caller hung up" },
    ]);

    const rows = await sql`
      SELECT judge_name, tag, instructions, verdict, reasoning, raw
      FROM session_external_evals
      WHERE session_id = ${s} AND source = 'goal'
      ORDER BY id
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0].judge_name).toBe("goal");
    expect(rows[0].tag).toBe("met-goal");
    expect(rows[0].instructions).toBe("The met goal");
    expect(rows[0].verdict).toBe("met");
    expect(rows[1].tag).toBe("unmet-goal");
    expect(rows[1].verdict).toBe("unmet");
    expect(rows[1].raw.what_went_wrong).toBe("Caller hung up");

    const [tracking] = await sql`
      SELECT status, analyzed_at FROM session_goal_analyses WHERE session_id = ${s}
    `;
    expect(tracking.status).toBe("done");
    expect(tracking.analyzed_at).not.toBeNull();

    expect(await claimOurs()).not.toContain(s);
  });

  test("listGoalResults groups verdicts per session with an agent-wide summary", async () => {
    const agentId = t.uid("agent");
    await t.seedAgent(agentId, null);
    const acct = t.uid("acct");

    const s1 = await t.seedSession({ accountId: acct, agentId, chatHistory: CHAT });
    await completeGoalAnalysis(s1, [
      { name: "g1", description: "G1 desc", met: true, reasoning: "yes", whatWentWrong: null },
      { name: "g2", description: "G2 desc", met: false, reasoning: "no", whatWentWrong: "hangup" },
    ]);
    const s2 = await t.seedSession({
      accountId: acct,
      agentId,
      chatHistory: CHAT,
      endedMinutesAgo: 5,
    });
    await completeGoalAnalysis(s2, [
      { name: "g1", description: "G1 desc", met: true, reasoning: "also yes", whatWentWrong: null },
    ]);
    // A session of the same agent WITHOUT goal verdicts must not appear.
    await t.seedSession({ accountId: acct, agentId, chatHistory: CHAT });

    const { rows, total, summary } = await listGoalResults({ agentId, limit: 50, offset: 0 });
    expect(total).toBe(2);
    expect(summary).toEqual({ sessions_total: 2, met_total: 2, unmet_total: 1 });
    // ended_at DESC: s1 (now) before s2 (5 minutes ago).
    expect(rows.map((r) => r.session_id)).toEqual([s1, s2]);
    expect(rows[0].met_count).toBe(1);
    expect(rows[0].unmet_count).toBe(1);
    expect(rows[0].goals).toHaveLength(2);
    expect(rows[0].goals[0]).toMatchObject({
      name: "g1",
      description: "G1 desc",
      verdict: "met",
      reasoning: "yes",
      what_went_wrong: null,
    });
    expect(rows[0].goals[1].what_went_wrong).toBe("hangup");

    // Pagination: page 2 of size 1 is s2, with total/summary unchanged.
    const page2 = await listGoalResults({ agentId, limit: 1, offset: 1 });
    expect(page2.rows.map((r) => r.session_id)).toEqual([s2]);
    expect(page2.total).toBe(2);
    expect(page2.summary.met_total).toBe(2);

    // account_id filter scopes everything.
    const other = await listGoalResults({ agentId, accountId: "nope", limit: 50, offset: 0 });
    expect(other.total).toBe(0);
    expect(other.rows).toHaveLength(0);
  });

  test("errors increment attempts, allow retry, and cap at 3", async () => {
    const s = await t.seedSession({ accountId: t.uid("acct"), chatHistory: CHAT });
    await t.seedTag(s, "goal:flaky");

    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = await claimOurs();
      expect(claimed).toContain(s);
      await markGoalAnalysisError(s, `boom ${attempt}`);
      const [row] = await sql`
        SELECT attempts, status, last_error FROM session_goal_analyses WHERE session_id = ${s}
      `;
      expect(row.attempts).toBe(attempt);
      expect(row.status).toBe("error");
      expect(row.last_error).toBe(`boom ${attempt}`);
    }

    // Attempt cap reached — never claimed again.
    expect(await claimOurs()).not.toContain(s);
  });
});
