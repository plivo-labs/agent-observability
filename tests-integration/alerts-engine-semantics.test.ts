/**
 * Integration tests for the evaluation semantics that only exist as SQL —
 * suppression eligibility, rolling-window arithmetic, rule scoping
 * (agent / judge), outcome normalization, and the per-turn data-quality
 * guards. The trigger suite proves each metric fires; this suite proves
 * each metric fires ONLY when it should.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { evaluateRules } from "../src/alerts/engine.js";
import { describeDb, testRun } from "./helpers.js";

const t = testRun("its");

describeDb("alert evaluation semantics against real Postgres", () => {
  beforeAll(async () => {
    await migrate(sql);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  /** Always-hot rule input: one failing eval = 100% fail rate over 1 sample. */
  async function seedHotRule(over: Record<string, unknown> = {}) {
    const acct = t.uid("acct");
    const sessionId = await t.seedSession({ accountId: acct });
    await t.seedEval(sessionId, "fail");
    const rule = await t.createRule({
      metric: "eval_fail_rate",
      account_id: acct,
      threshold_value: 0.5,
      min_samples: 1,
      ...over,
    });
    return { acct, sessionId, rule };
  }

  // ── Suppression ───────────────────────────────────────────────────────────

  test("a rule that fired within its window is skipped entirely", async () => {
    const { rule } = await seedHotRule();
    await t.setLastFired(rule.id, 5); // fired 5 min ago, window is 15

    await evaluateRules();
    expect(await t.firingsFor(rule.id)).toHaveLength(0);
  });

  test("a rule whose suppression has lapsed re-fires and re-stamps last_fired_at", async () => {
    const { rule } = await seedHotRule();
    await t.setLastFired(rule.id, 16); // window is 15 — eligible again

    await evaluateRules();
    expect(await t.firingsFor(rule.id)).toHaveLength(1);

    const [row] = await sql`SELECT last_fired_at FROM alert_rules WHERE id = ${rule.id}`;
    const stampAge = Date.now() - new Date(row.last_fired_at).getTime();
    expect(stampAge).toBeLessThan(60_000); // re-stamped to now, not left at -16min
  });

  test("editing a rule does not reset suppression", async () => {
    const { rule } = await seedHotRule();
    await t.setLastFired(rule.id, 5);
    await sql`UPDATE alert_rules SET threshold_value = 0.01, updated_at = NOW() WHERE id = ${rule.id}`;

    await evaluateRules();
    expect(await t.firingsFor(rule.id)).toHaveLength(0); // still suppressed
  });

  test("disabled rules are never evaluated", async () => {
    const { rule } = await seedHotRule({ enabled: false });

    await evaluateRules();
    expect(await t.firingsFor(rule.id)).toHaveLength(0);
  });

  // ── Rolling-window arithmetic ─────────────────────────────────────────────

  test("evals older than the window do not count", async () => {
    const acct = t.uid("acct");
    const sessionId = await t.seedSession({ accountId: acct });
    await t.seedEval(sessionId, "fail", "it_judge", 20); // 20 min ago, window 15

    const rule = await t.createRule({
      metric: "eval_fail_rate",
      account_id: acct,
      threshold_value: 0.5,
      min_samples: 1,
    });
    await evaluateRules();
    expect(await t.firingsFor(rule.id)).toHaveLength(0);
  });

  test("latency windows on session ended_at — sessions ended before the window are invisible", async () => {
    const acct = t.uid("acct");
    await t.seedSession({
      accountId: acct,
      endedMinutesAgo: 20, // window is 15
      perTurn: [{ item_id: "t1", llm_node_ttft: 9.0 }],
    });

    const rule = await t.createRule({
      metric: "latency_llm_ttft_p95",
      account_id: acct,
      threshold_value: 100,
      min_samples: 1,
    });
    await evaluateRules();
    expect(await t.firingsFor(rule.id)).toHaveLength(0);
  });

  test("outcomes window on updated_at", async () => {
    const acct = t.uid("acct");
    const sessionId = await t.seedSession({ accountId: acct });
    await t.seedOutcome(sessionId, "fail", 20); // updated 20 min ago, window 15

    const rule = await t.createRule({
      metric: "outcome_fail_rate",
      account_id: acct,
      threshold_value: 0.5,
      min_samples: 1,
    });
    await evaluateRules();
    expect(await t.firingsFor(rule.id)).toHaveLength(0);
  });

  // ── Scoping filters ───────────────────────────────────────────────────────

  test("judge_name restricts counting to that judge", async () => {
    const acct = t.uid("acct");
    const sessionId = await t.seedSession({ accountId: acct });
    await t.seedEval(sessionId, "fail", "other_judge");
    await t.seedEval(sessionId, "pass", "watched_judge");

    const scoped = await t.createRule({
      metric: "eval_fail_rate",
      account_id: acct,
      judge_name: "watched_judge",
      threshold_value: 0.5,
      min_samples: 1,
    });
    await evaluateRules();
    // other_judge's fail is invisible; watched_judge is 0% fail.
    expect(await t.firingsFor(scoped.id)).toHaveLength(0);

    const unscoped = await t.createRule({
      metric: "eval_fail_rate",
      account_id: acct,
      judge_name: null,
      threshold_value: 0.4,
      min_samples: 2,
    });
    await evaluateRules();
    const firings = await t.firingsFor(unscoped.id);
    expect(firings).toHaveLength(1); // both judges count: 1/2 fail
    expect(Number(firings[0].observed_value)).toBeCloseTo(0.5);
  });

  test("agent_id scopes via the session join; evals on other agents are invisible", async () => {
    const acct = t.uid("acct");
    const agentA = t.uid("agent");
    const agentB = t.uid("agent");
    await t.seedAgent(agentA, acct);
    await t.seedAgent(agentB, acct);
    const sessA = await t.seedSession({ accountId: acct, agentId: agentA });
    const sessB = await t.seedSession({ accountId: acct, agentId: agentB });
    await t.seedEval(sessA, "pass");
    await t.seedEval(sessB, "fail");

    const rule = await t.createRule({
      metric: "eval_fail_rate",
      agent_id: agentA,
      threshold_value: 0.5,
      min_samples: 1,
    });
    await evaluateRules();
    expect(await t.firingsFor(rule.id)).toHaveLength(0); // agent A is clean
  });

  test("an eval arriving before its session row counts for unscoped rules but not agent-scoped ones", async () => {
    const acct = t.uid("acct");
    const agentA = t.uid("agent");
    await t.seedAgent(agentA, acct);
    const orphan = t.uid("orphan-sess"); // never inserted into sessions
    await t.seedEval(orphan, "fail");

    const agentScoped = await t.createRule({
      metric: "eval_fail_rate",
      agent_id: agentA,
      threshold_value: 0.5,
      min_samples: 1,
    });
    await evaluateRules();
    // LEFT JOIN yields NULL agent_id — excluded from the scoped rule.
    expect(await t.firingsFor(agentScoped.id)).toHaveLength(0);

    // Account-unscoped rules can't be used here (they'd see other suites'
    // rows), but the orphan eval must still be visible to SQL: prove the
    // LEFT JOIN keeps it rather than dropping it.
    const [row] = await sql`
      SELECT COUNT(*)::int AS n
      FROM session_external_evals e
      LEFT JOIN agent_transport_sessions s ON s.session_id = e.session_id
      WHERE e.session_id = ${orphan}
    `;
    expect(row.n).toBe(1);
  });

  test("one sweep evaluates every eligible rule independently", async () => {
    const acctA = t.uid("acct");
    const acctB = t.uid("acct");
    const sessA = await t.seedSession({ accountId: acctA });
    const sessB = await t.seedSession({
      accountId: acctB,
      perTurn: [{ item_id: "t1", llm_node_ttft: 5.0 }],
    });
    await t.seedEval(sessA, "fail");

    const evalRule = await t.createRule({
      metric: "eval_fail_rate",
      account_id: acctA,
      threshold_value: 0.5,
      min_samples: 1,
    });
    const latencyRule = await t.createRule({
      metric: "latency_llm_ttft_p95",
      account_id: acctB,
      threshold_value: 1000,
      min_samples: 1,
    });
    const quietRule = await t.createRule({
      metric: "eval_fail_rate",
      account_id: acctB, // no evals on this account at all
      threshold_value: 0.5,
      min_samples: 1,
    });

    await evaluateRules(); // single sweep
    expect(await t.firingsFor(evalRule.id)).toHaveLength(1);
    expect(await t.firingsFor(latencyRule.id)).toHaveLength(1);
    expect(await t.firingsFor(quietRule.id)).toHaveLength(0);
    void sessB;
  });

  test("agent_id scoping applies to latency metrics too", async () => {
    const acct = t.uid("acct");
    const agentSlow = t.uid("agent");
    const agentWatched = t.uid("agent");
    await t.seedAgent(agentSlow, acct);
    await t.seedAgent(agentWatched, acct);
    await t.seedSession({
      accountId: acct,
      agentId: agentSlow,
      perTurn: [{ item_id: "t1", llm_node_ttft: 9.0 }],
    });

    const rule = await t.createRule({
      metric: "latency_llm_ttft_p95",
      agent_id: agentWatched,
      threshold_value: 1000,
      min_samples: 1,
    });
    await evaluateRules();
    expect(await t.firingsFor(rule.id)).toHaveLength(0); // slow agent ≠ watched agent
  });

  // ── Verdict matching ──────────────────────────────────────────────────────

  test("eval verdicts match 'fail' case-insensitively but not other words", async () => {
    const acct = t.uid("acct");
    const sessionId = await t.seedSession({ accountId: acct });
    await t.seedEval(sessionId, "FAIL"); // counts
    await t.seedEval(sessionId, "failed"); // does NOT count — exact word only
    await t.seedEval(sessionId, "error"); // does NOT count

    const rule = await t.createRule({
      metric: "eval_fail_rate",
      account_id: acct,
      threshold_value: 0.3,
      min_samples: 3,
    });
    await evaluateRules();
    const [firing] = await t.firingsFor(rule.id);
    expect(firing).toBeDefined();
    expect(firing.matched_count).toBe(1); // only the uppercase FAIL
    expect(firing.total_count).toBe(3);
    expect(Number(firing.observed_value)).toBeCloseTo(1 / 3);
  });

  // ── Outcome normalization ─────────────────────────────────────────────────

  test("lk.-prefixed and 'failure' outcomes count as failures; lk.success does not", async () => {
    const acct = t.uid("acct");
    const s1 = await t.seedSession({ accountId: acct });
    const s2 = await t.seedSession({ accountId: acct });
    const s3 = await t.seedSession({ accountId: acct });
    await t.seedOutcome(s1, "lk.fail");
    await t.seedOutcome(s2, "FAILURE"); // case-insensitive too
    await t.seedOutcome(s3, "lk.success");

    const rule = await t.createRule({
      metric: "outcome_fail_rate",
      account_id: acct,
      threshold_value: 0.5,
      min_samples: 3,
    });
    await evaluateRules();
    const firings = await t.firingsFor(rule.id);
    expect(firings).toHaveLength(1);
    expect(Number(firings[0].observed_value)).toBeCloseTo(2 / 3);
    expect(firings[0].matched_count).toBe(2);
    expect(firings[0].total_count).toBe(3);
  });

  // ── Per-turn data quality ─────────────────────────────────────────────────

  test("turns without a numeric value are not samples", async () => {
    const acct = t.uid("acct");
    await t.seedSession({
      accountId: acct,
      perTurn: [
        { item_id: "t1" }, // field absent
        { item_id: "t2", llm_node_ttft: "" }, // empty string
        { item_id: "t3", llm_node_ttft: "fast" }, // non-numeric
        { item_id: "t4", llm_node_ttft: null }, // null
      ],
    });

    const rule = await t.createRule({
      metric: "latency_llm_ttft_p95",
      account_id: acct,
      threshold_value: 1,
      min_samples: 1,
    });
    await evaluateRules();
    expect(await t.firingsFor(rule.id)).toHaveLength(0); // zero usable samples
  });

  test("null and non-array session_metrics/per_turn never break evaluation", async () => {
    const acct = t.uid("acct");
    await t.seedSession({ accountId: acct, sessionMetrics: null });
    await t.seedSession({ accountId: acct, sessionMetrics: { per_turn: "oops" } });
    await t.seedSession({
      accountId: acct,
      perTurn: [{ item_id: "t1", llm_node_ttft: 5.0 }],
    });

    const rule = await t.createRule({
      metric: "latency_llm_ttft_p95",
      account_id: acct,
      threshold_value: 1000,
      min_samples: 1,
    });
    await evaluateRules();
    const firings = await t.firingsFor(rule.id);
    expect(firings).toHaveLength(1); // the good turn fires; the junk is skipped
    expect(Number(firings[0].observed_value)).toBeCloseTo(5000);
  });

  test("null chat_history never breaks interruption_rate", async () => {
    const acct = t.uid("acct");
    await t.seedSession({ accountId: acct, chatHistory: null });
    await t.seedSession({
      accountId: acct,
      chatHistory: [{ type: "message", role: "assistant", content: "a", interrupted: true }],
    });

    const rule = await t.createRule({
      metric: "interruption_rate",
      account_id: acct,
      threshold_value: 0.5,
      min_samples: 1,
    });
    await evaluateRules();
    const firings = await t.firingsFor(rule.id);
    expect(firings).toHaveLength(1); // 1/1 interrupted; the null row is skipped
    expect(Number(firings[0].observed_value)).toBeCloseTo(1);
  });

  test("sample_session_ids is capped at 20 sessions", async () => {
    const acct = t.uid("acct");
    for (let i = 0; i < 25; i++) {
      const sessionId = await t.seedSession({ accountId: acct });
      await t.seedEval(sessionId, "fail");
    }

    const rule = await t.createRule({
      metric: "eval_fail_rate",
      account_id: acct,
      threshold_value: 0.5,
      min_samples: 1,
    });
    await evaluateRules();
    const [firing] = await t.firingsFor(rule.id);
    expect(firing.matched_count).toBe(25);
    const ids = typeof firing.sample_session_ids === "string"
      ? JSON.parse(firing.sample_session_ids)
      : firing.sample_session_ids;
    expect(ids).toHaveLength(20);
  });

  test("p95 tolerates a lone outlier at 21+ samples (max would not)", async () => {
    const acct = t.uid("acct");
    const fast = Array.from({ length: 21 }, (_, i) => ({
      item_id: `t${i}`,
      llm_node_ttft: 0.5,
    }));
    await t.seedSession({
      accountId: acct,
      perTurn: [...fast, { item_id: "spike", llm_node_ttft: 9.9 }],
    });

    const rule = await t.createRule({
      metric: "latency_llm_ttft_p95",
      account_id: acct,
      threshold_value: 2000,
      min_samples: 1,
    });
    await evaluateRules();
    // percentile_disc(0.95) over 22 samples picks the 21st — still 500ms.
    expect(await t.firingsFor(rule.id)).toHaveLength(0);
  });

  test("latency firing rows carry samples in matched_count, null total_count, and only over-threshold sessions", async () => {
    const acct = t.uid("acct");
    const slow = await t.seedSession({
      accountId: acct,
      perTurn: [{ item_id: "t1", llm_node_ttft: 5.0 }],
    });
    const fastSession = await t.seedSession({
      accountId: acct,
      perTurn: [{ item_id: "t1", llm_node_ttft: 0.1 }],
    });

    const rule = await t.createRule({
      metric: "latency_llm_ttft_p95",
      account_id: acct,
      threshold_value: 1000,
      min_samples: 2,
    });
    await evaluateRules();
    const [firing] = await t.firingsFor(rule.id);
    expect(firing.matched_count).toBe(2); // both turns are samples
    expect(firing.total_count).toBeNull(); // p95 has no denominator
    const ids = typeof firing.sample_session_ids === "string"
      ? JSON.parse(firing.sample_session_ids)
      : firing.sample_session_ids;
    expect(ids).toContain(slow);
    expect(ids).not.toContain(fastSession);
  });
});
