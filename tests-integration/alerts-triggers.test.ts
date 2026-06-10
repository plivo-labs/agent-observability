/**
 * Integration tests for every alert trigger against a REAL Postgres —
 * the unit suite mocks sql, so the actual query text (jsonb bindings,
 * window intervals, percentile SQL) is only proven here.
 *
 * Run with `bun run test:integration` (needs DATABASE_URL; skips with a
 * console notice when the database is unreachable). Lives outside tests/
 * deliberately: bun shares one module registry per process and tests/
 * mock ../src/db.js, which would poison the real imports needed here.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { evaluateRules } from "../src/alerts/engine.js";
import { describeDb, testRun } from "./helpers.js";

const t = testRun("it");

describeDb("alert triggers against real Postgres", () => {
  beforeAll(async () => {
    await migrate(sql);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  test("evaluation_count fires on matching verdicts and dedups within the window", async () => {
    const acct = t.uid("acct");
    const s1 = await t.seedSession({ accountId: acct });
    await t.seedEval(s1, "fail");
    await t.seedEval(s1, "fail");
    const rule = await t.createRule({
      trigger_type: "evaluation_count",
      account_id: acct,
      threshold_count: 2,
    });

    await evaluateRules();
    let firings = await t.firingsFor(rule.id);
    expect(firings).toHaveLength(1);
    expect(firings[0].matched_count).toBe(2);
    expect(firings[0].observed_value).toBeNull(); // counts carry no scalar metric
    expect(firings[0].sample_session_ids).toContain(s1);

    // Suppressed: same window, no second firing.
    await evaluateRules();
    firings = await t.firingsFor(rule.id);
    expect(firings).toHaveLength(1);
  });

  test("evaluation_count respects the judge filter", async () => {
    const acct = t.uid("acct");
    const s1 = await t.seedSession({ accountId: acct });
    await t.seedEval(s1, "fail", "other_judge");
    const rule = await t.createRule({
      trigger_type: "evaluation_count",
      account_id: acct,
      threshold_count: 1,
      judge_name: "it_judge",
    });

    await evaluateRules();
    expect(await t.firingsFor(rule.id)).toHaveLength(0);
  });

  test("outcome_count matches lk.-prefixed outcomes", async () => {
    const acct = t.uid("acct");
    const s1 = await t.seedSession({ accountId: acct });
    await t.seedOutcome(s1, "lk.fail");
    const rule = await t.createRule({
      trigger_type: "outcome_count",
      account_id: acct,
      threshold_count: 1,
    });

    await evaluateRules();
    const firings = await t.firingsFor(rule.id);
    expect(firings).toHaveLength(1);
    expect(firings[0].matched_count).toBe(1);
  });

  test("eval_fail_rate fires above the threshold and gates on min_samples", async () => {
    const acct = t.uid("acct");
    const s1 = await t.seedSession({ accountId: acct });
    await t.seedEval(s1, "fail");
    await t.seedEval(s1, "fail");
    await t.seedEval(s1, "pass");
    await t.seedEval(s1, "pass"); // 50% fail over 4 samples

    const gated = await t.createRule({
      trigger_type: "metric_threshold",
      metric: "eval_fail_rate",
      account_id: acct,
      threshold_count: null,
      threshold_value: 0.3,
      min_samples: 10,
    });
    await evaluateRules();
    expect(await t.firingsFor(gated.id)).toHaveLength(0); // 4 < 10 samples

    const armed = await t.createRule({
      trigger_type: "metric_threshold",
      metric: "eval_fail_rate",
      account_id: acct,
      threshold_count: null,
      threshold_value: 0.3,
      min_samples: 4,
    });
    await evaluateRules();
    const firings = await t.firingsFor(armed.id);
    expect(firings).toHaveLength(1);
    expect(Number(firings[0].observed_value)).toBeCloseTo(0.5);
    expect(firings[0].matched_count).toBe(2);
    expect(firings[0].total_count).toBe(4);
  });

  test("outcome_fail_rate fires above the threshold", async () => {
    const acct = t.uid("acct");
    const s1 = await t.seedSession({ accountId: acct });
    const s2 = await t.seedSession({ accountId: acct });
    await t.seedOutcome(s1, "fail");
    await t.seedOutcome(s2, "success");

    const rule = await t.createRule({
      trigger_type: "metric_threshold",
      metric: "outcome_fail_rate",
      account_id: acct,
      threshold_count: null,
      threshold_value: 0.4,
      min_samples: 2,
    });
    await evaluateRules();
    const firings = await t.firingsFor(rule.id);
    expect(firings).toHaveLength(1);
    expect(Number(firings[0].observed_value)).toBeCloseTo(0.5);
  });

  test.each([
    ["latency_perceived_p95", { e2e_latency: 3.2 }],
    ["latency_llm_ttft_p95", { llm_node_ttft: 3.2 }],
    ["latency_tts_ttfb_p95", { tts_node_ttfb: 3.2 }],
    ["latency_stt_p95", { transcription_delay: 3.2 }],
  ] as const)("%s fires when p95 exceeds the ms threshold", async (metric, turnMetrics) => {
    const acct = t.uid("acct");
    await t.seedSession({
      accountId: acct,
      perTurn: [
        { item_id: "t1", ...turnMetrics },
        { item_id: "t2", ...turnMetrics },
      ],
    });

    const rule = await t.createRule({
      trigger_type: "metric_threshold",
      metric,
      account_id: acct,
      threshold_count: null,
      threshold_value: 2000, // 3.2s observed > 2000ms
      min_samples: 2,
    });
    await evaluateRules();
    const firings = await t.firingsFor(rule.id);
    expect(firings).toHaveLength(1);
    expect(Number(firings[0].observed_value)).toBeCloseTo(3200);
  });

  test("interruption_rate counts interrupted assistant turns", async () => {
    const acct = t.uid("acct");
    const chat = [
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "assistant", content: "a", interrupted: true },
      { type: "message", role: "assistant", content: "b", interrupted: false },
    ];
    await t.seedSession({ accountId: acct, chatHistory: chat });

    const rule = await t.createRule({
      trigger_type: "metric_threshold",
      metric: "interruption_rate",
      account_id: acct,
      threshold_count: null,
      threshold_value: 0.25,
      min_samples: 2,
    });
    await evaluateRules();
    const firings = await t.firingsFor(rule.id);
    expect(firings).toHaveLength(1);
    expect(Number(firings[0].observed_value)).toBeCloseTo(0.5);
  });


});
