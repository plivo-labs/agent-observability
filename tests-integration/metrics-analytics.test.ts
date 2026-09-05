// Per-metric analytics aggregation over real Postgres: pass rates, calls,
// default-vs-custom split, and account/agent scoping. The unit suite mocks
// sql, so the window CTE + external_evals join are only proven here.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { describeDb, testRun } from "./helpers.js";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { getMetricsAnalytics } from "../src/analytics/metrics-analytics.js";

const t = testRun("metrics-analytics");
const acct = t.run + "-acct";
const agentId = t.uid("agent");
const otherAgent = t.uid("other");

async function seedSession(sessionId: string, agent: string): Promise<void> {
  await sql`
    INSERT INTO ao_agent_transport_sessions
      (session_id, account_id, agent_id, started_at, ended_at, duration_ms, turn_count, chat_history, session_metrics, raw_report, transport)
    VALUES (${sessionId}, ${acct}, ${agent}, NOW() - interval '2 hours', NOW() - interval '110 minutes', 60000, 1,
      '{"items":[]}'::jsonb, '{}'::jsonb, NULL, 'livekit')
  `;
}
async function seedVerdict(sessionId: string, judge: string, verdict: string): Promise<void> {
  await sql`
    INSERT INTO ao_session_external_evals (session_id, judge_name, verdict, reasoning, source, created_at)
    VALUES (${sessionId}, ${judge}, ${verdict}, ${"r"}, ${"eval_sweeper"}, NOW() - interval '111 minutes')
  `;
}

describeDb("metrics analytics (real PG)", () => {
  beforeAll(async () => {
    await migrate(sql);
    await t.seedAgent(agentId, acct);
    await t.seedAgent(otherAgent, acct);
    // agent under test: 3 calls. hallucination = 2 pass / 1 fail; a custom
    // metric = 1 pass / 2 fail.
    for (const [i, hv, cv] of [
      [0, "pass", "pass"],
      [1, "pass", "fail"],
      [2, "fail", "fail"],
    ] as Array<[number, string, string]>) {
      const sid = t.uid(`sess${i}`);
      await seedSession(sid, agentId);
      await seedVerdict(sid, "hallucination", hv);
      await seedVerdict(sid, "metric:insurance_verified", cv);
    }
    // a different agent's call — must NOT leak into an agent-scoped query
    const other = t.uid("other-sess");
    await seedSession(other, otherAgent);
    await seedVerdict(other, "hallucination", "fail");
  });
  afterAll(async () => {
    await sql`DELETE FROM ao_session_external_evals WHERE session_id IN (SELECT session_id FROM ao_agent_transport_sessions WHERE account_id = ${acct})`;
    await sql`DELETE FROM ao_agent_transport_sessions WHERE account_id = ${acct}`;
  });

  test("aggregates pass rates and splits default vs custom, scoped to the agent", async () => {
    const a = await getMetricsAnalytics({ range: "24h", accountId: acct, agentId, target: 0.75 });

    const hall = a.default_checks.find((m) => m.judge_name === "hallucination");
    expect(hall).toBeDefined();
    expect(hall!.passed).toBe(2);
    expect(hall!.failed).toBe(1);
    expect(hall!.pass_rate).toBeCloseTo(2 / 3, 5);
    expect(hall!.calls).toBe(3);

    const custom = a.custom_metrics.find((m) => m.judge_name === "metric:insurance_verified");
    expect(custom).toBeDefined();
    expect(custom!.pass_rate).toBeCloseTo(1 / 3, 5);

    // KPIs: overall = 3 pass / 6 decided; both metrics below the 0.75 target.
    expect(a.kpis.overall_pass_rate).toBeCloseTo(3 / 6, 5);
    expect(a.kpis.calls_scored).toBe(3);
    expect(a.kpis.default_metric_count).toBe(1);
    expect(a.kpis.custom_metric_count).toBe(1);
    expect(a.kpis.below_target_count).toBe(2);
  });

  test("account/agent scoping excludes another agent's calls", async () => {
    const a = await getMetricsAnalytics({ range: "24h", accountId: acct, agentId, target: 0.75 });
    // the other agent's failing hallucination verdict must not inflate the count
    const hall = a.default_checks.find((m) => m.judge_name === "hallucination");
    expect(hall!.passed + hall!.failed).toBe(3); // 3, not 4
  });
});
