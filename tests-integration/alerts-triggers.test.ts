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
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { evaluateRules } from "../src/alerts/engine.js";
import { insertAlertRule, type AlertRuleRow } from "../src/alerts/db.js";
import type { AlertRuleCreate } from "../src/alerts/schema.js";

const RUN = `it-${Date.now().toString(36)}`;

let dbUp = true;
try {
  await sql`SELECT 1`;
} catch {
  dbUp = false;
  console.warn("[integration] DATABASE_URL unreachable — skipping alert trigger suite");
}
const d = dbUp ? describe : describe.skip;

// ── Seed helpers ────────────────────────────────────────────────────────────

let seq = 0;
const uid = (tag: string) => `${RUN}-${tag}-${++seq}`;

async function seedSession(opts: {
  accountId: string;
  chatHistory?: unknown[];
  perTurn?: Array<Record<string, unknown>>;
}): Promise<string> {
  const sessionId = uid("sess");
  await sql`
    INSERT INTO agent_transport_sessions (
      session_id, account_id, started_at, ended_at, duration_ms, turn_count,
      chat_history, session_metrics
    ) VALUES (
      ${sessionId}, ${opts.accountId}, NOW() - interval '2 minutes', NOW(), 120000, 1,
      ${opts.chatHistory ?? []}::jsonb,
      ${{ per_turn: opts.perTurn ?? [] }}::jsonb
    )
  `;
  return sessionId;
}

async function seedEval(sessionId: string, verdict: string, judge = "it_judge"): Promise<void> {
  await sql`
    INSERT INTO session_external_evals (session_id, source, judge_name, verdict)
    VALUES (${sessionId}, ${RUN}, ${judge}, ${verdict})
  `;
}

async function seedOutcome(sessionId: string, outcome: string): Promise<void> {
  await sql`
    INSERT INTO session_outcomes (session_id, source, outcome)
    VALUES (${sessionId}, ${RUN}, ${outcome})
  `;
}

const BASE_RULE: Omit<AlertRuleCreate, "trigger_type" | "account_id"> = {
  name: `${RUN} rule`,
  enabled: true,
  agent_id: null,
  metric: null,
  judge_name: null,
  verdicts: ["fail"],
  threshold_count: null,
  threshold_value: null,
  min_samples: 1,
  window_minutes: 15,
  webhook_url: "http://localhost:1/never-delivered",
  http_method: "POST",
  secret: null,
  headers: null,
};

async function createRule(over: Partial<AlertRuleCreate> & { account_id: string }): Promise<AlertRuleRow> {
  return insertAlertRule({ ...BASE_RULE, ...over, name: `${RUN} ${over.metric ?? over.trigger_type}` } as AlertRuleCreate);
}

async function firingsFor(ruleId: string): Promise<any[]> {
  return await sql`SELECT * FROM alert_firings WHERE rule_id = ${ruleId}`;
}

d("alert triggers against real Postgres", () => {
  beforeAll(async () => {
    await migrate(sql);
  });

  afterAll(async () => {
    // Cascade cleans firings/attempts; evals/outcomes/sessions by run tag.
    await sql`DELETE FROM alert_rules WHERE name LIKE ${RUN + "%"}`;
    await sql`DELETE FROM session_external_evals WHERE source = ${RUN}`;
    await sql`DELETE FROM session_outcomes WHERE source = ${RUN}`;
    await sql`DELETE FROM agent_transport_sessions WHERE account_id LIKE ${RUN + "%"}`;
    // NOTE: never close the shared sql pool here — both integration files
    // run in one bun process and the second file still needs it.
  });

  test("evaluation_count fires on matching verdicts and dedups within the window", async () => {
    const acct = uid("acct");
    const s1 = await seedSession({ accountId: acct });
    await seedEval(s1, "fail");
    await seedEval(s1, "fail");
    const rule = await createRule({
      trigger_type: "evaluation_count",
      account_id: acct,
      threshold_count: 2,
    });

    await evaluateRules();
    let firings = await firingsFor(rule.id);
    expect(firings).toHaveLength(1);
    expect(firings[0].matched_count).toBe(2);
    expect(firings[0].sample_session_ids).toContain(s1);

    // Suppressed: same window, no second firing.
    await evaluateRules();
    firings = await firingsFor(rule.id);
    expect(firings).toHaveLength(1);
  });

  test("evaluation_count respects the judge filter", async () => {
    const acct = uid("acct");
    const s1 = await seedSession({ accountId: acct });
    await seedEval(s1, "fail", "other_judge");
    const rule = await createRule({
      trigger_type: "evaluation_count",
      account_id: acct,
      threshold_count: 1,
      judge_name: "it_judge",
    });

    await evaluateRules();
    expect(await firingsFor(rule.id)).toHaveLength(0);
  });

  test("outcome_count matches lk.-prefixed outcomes", async () => {
    const acct = uid("acct");
    const s1 = await seedSession({ accountId: acct });
    await seedOutcome(s1, "lk.fail");
    const rule = await createRule({
      trigger_type: "outcome_count",
      account_id: acct,
      threshold_count: 1,
    });

    await evaluateRules();
    const firings = await firingsFor(rule.id);
    expect(firings).toHaveLength(1);
    expect(firings[0].matched_count).toBe(1);
  });

  test("eval_fail_rate fires above the threshold and gates on min_samples", async () => {
    const acct = uid("acct");
    const s1 = await seedSession({ accountId: acct });
    await seedEval(s1, "fail");
    await seedEval(s1, "fail");
    await seedEval(s1, "pass");
    await seedEval(s1, "pass"); // 50% fail over 4 samples

    const gated = await createRule({
      trigger_type: "metric_threshold",
      metric: "eval_fail_rate",
      account_id: acct,
      threshold_value: 0.3,
      min_samples: 10,
    });
    await evaluateRules();
    expect(await firingsFor(gated.id)).toHaveLength(0); // 4 < 10 samples

    const armed = await createRule({
      trigger_type: "metric_threshold",
      metric: "eval_fail_rate",
      account_id: acct,
      threshold_value: 0.3,
      min_samples: 4,
    });
    await evaluateRules();
    const firings = await firingsFor(armed.id);
    expect(firings).toHaveLength(1);
    expect(Number(firings[0].observed_value)).toBeCloseTo(0.5);
    expect(firings[0].matched_count).toBe(2);
    expect(firings[0].total_count).toBe(4);
  });

  test("outcome_fail_rate fires above the threshold", async () => {
    const acct = uid("acct");
    const s1 = await seedSession({ accountId: acct });
    const s2 = await seedSession({ accountId: acct });
    await seedOutcome(s1, "fail");
    await seedOutcome(s2, "success");

    const rule = await createRule({
      trigger_type: "metric_threshold",
      metric: "outcome_fail_rate",
      account_id: acct,
      threshold_value: 0.4,
      min_samples: 2,
    });
    await evaluateRules();
    const firings = await firingsFor(rule.id);
    expect(firings).toHaveLength(1);
    expect(Number(firings[0].observed_value)).toBeCloseTo(0.5);
  });

  test.each([
    ["latency_perceived_p95", { e2e_latency: 3.2 }],
    ["latency_llm_ttft_p95", { llm_node_ttft: 3.2 }],
    ["latency_tts_ttfb_p95", { tts_node_ttfb: 3.2 }],
    ["latency_stt_p95", { transcription_delay: 3.2 }],
  ] as const)("%s fires when p95 exceeds the ms threshold", async (metric, turnMetrics) => {
    const acct = uid("acct");
    await seedSession({
      accountId: acct,
      perTurn: [
        { item_id: "t1", ...turnMetrics },
        { item_id: "t2", ...turnMetrics },
      ],
    });

    const rule = await createRule({
      trigger_type: "metric_threshold",
      metric,
      account_id: acct,
      threshold_value: 2000, // 3.2s observed > 2000ms
      min_samples: 2,
    });
    await evaluateRules();
    const firings = await firingsFor(rule.id);
    expect(firings).toHaveLength(1);
    expect(Number(firings[0].observed_value)).toBeCloseTo(3200);
  });

  test("interruption_rate counts interrupted assistant turns", async () => {
    const acct = uid("acct");
    const chat = [
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "assistant", content: "a", interrupted: true },
      { type: "message", role: "assistant", content: "b", interrupted: false },
    ];
    await seedSession({ accountId: acct, chatHistory: chat });

    const rule = await createRule({
      trigger_type: "metric_threshold",
      metric: "interruption_rate",
      account_id: acct,
      threshold_value: 0.25,
      min_samples: 2,
    });
    await evaluateRules();
    const firings = await firingsFor(rule.id);
    expect(firings).toHaveLength(1);
    expect(Number(firings[0].observed_value)).toBeCloseTo(0.5);
  });

  test("session_volume fires when the count is BELOW the floor (agent-down)", async () => {
    const acct = uid("acct");
    await seedSession({ accountId: acct }); // 1 session < floor of 5

    const rule = await createRule({
      trigger_type: "metric_threshold",
      metric: "session_volume",
      account_id: acct,
      threshold_value: 5,
    });
    await evaluateRules();
    const firings = await firingsFor(rule.id);
    expect(firings).toHaveLength(1);
    expect(Number(firings[0].observed_value)).toBe(1);
  });

  test("session_volume stays quiet at the floor", async () => {
    const acct = uid("acct");
    await seedSession({ accountId: acct });
    await seedSession({ accountId: acct });

    const rule = await createRule({
      trigger_type: "metric_threshold",
      metric: "session_volume",
      account_id: acct,
      threshold_value: 2, // 2 sessions is NOT below 2
    });
    await evaluateRules();
    expect(await firingsFor(rule.id)).toHaveLength(0);
  });
});
