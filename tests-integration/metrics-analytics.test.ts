// Per-metric analytics aggregation over real Postgres: pass rates, calls,
// default-vs-custom split, and account/agent scoping. The unit suite mocks
// sql, so the window CTE + external_evals join are only proven here.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { describeDb, testRun } from "./helpers.js";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { getMetricFailedRuns, getMetricsAnalytics } from "../src/analytics/metrics-analytics.js";

const t = testRun("metrics-analytics");
const acct = t.run + "-acct";
const agentId = t.uid("agent");
const otherAgent = t.uid("other");
// flow_run_uuid seeded per session index, so the failed-runs test can assert exact ids.
const sessFru: string[] = [];

async function seedSession(sessionId: string, agent: string): Promise<void> {
  await sql`
    INSERT INTO ao_agent_transport_sessions
      (session_id, account_id, agent_id, started_at, ended_at, duration_ms, turn_count, chat_history, session_metrics, raw_report, transport)
    VALUES (${sessionId}, ${acct}, ${agent}, NOW() - interval '2 hours', NOW() - interval '110 minutes', 60000, 1,
      '{"items":[]}'::jsonb, '{}'::jsonb, NULL, 'livekit')
  `;
}
async function seedVerdict(
  sessionId: string,
  judge: string,
  verdict: string,
  tag: string | null = null,
): Promise<void> {
  await sql`
    INSERT INTO ao_session_external_evals (session_id, judge_name, verdict, reasoning, source, tag, created_at)
    VALUES (${sessionId}, ${judge}, ${verdict}, ${"r"}, ${"eval_sweeper"}, ${tag}, NOW() - interval '111 minutes')
  `;
}
async function seedFlowRunTag(sessionId: string, flowRunUuid: string): Promise<void> {
  await sql`
    INSERT INTO ao_session_tags (session_id, name, metadata, source, observed_at)
    VALUES (${sessionId}, ${"flow_run_uuid:" + flowRunUuid}, '{}'::jsonb, ${"test"}, NOW())
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
      const fru = t.uid(`fru${i}`);
      sessFru[i] = fru;
      await seedSession(sid, agentId);
      await seedFlowRunTag(sid, fru);
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
    await sql`DELETE FROM ao_session_tags WHERE session_id IN (SELECT session_id FROM ao_agent_transport_sessions WHERE account_id = ${acct})`;
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

  test("metric-failed-runs returns the flow_run_uuids that failed a metric, scoped", async () => {
    const r = await getMetricFailedRuns({
      range: "24h",
      accountId: acct,
      agentId,
      judgeName: "metric:insurance_verified",
    });
    // insurance_verified failed on the 2nd and 3rd calls.
    expect(r.flow_run_uuids.slice().sort()).toEqual([sessFru[1], sessFru[2]].sort());

    // hallucination failed only on the 3rd call (the other agent's fail is out of scope).
    const h = await getMetricFailedRuns({
      range: "24h",
      accountId: acct,
      agentId,
      judgeName: "hallucination",
    });
    expect(h.flow_run_uuids).toEqual([sessFru[2]]);
  });

  test("orphaned verdict names are dropped; a definition-less custom derives scope from its tags", async () => {
    // a retired/orphaned default name (no ao_judges row, not a metric:) must be dropped —
    // neither shown as a check nor counted, so the default count reflects the catalogue.
    const orph = t.uid("orph");
    await seedSession(orph, agentId);
    await seedVerdict(orph, "goal:retired_thing", "fail");
    // a custom whose definition row is absent, with a node-tagged verdict → node scope derived.
    const nodeSid = t.uid("node-custom");
    await seedSession(nodeSid, agentId);
    await seedVerdict(nodeSid, "metric:node_only", "pass", "node-abc");

    const a = await getMetricsAnalytics({ range: "24h", accountId: acct, agentId, target: 0.75 });

    expect(a.default_checks.some((m) => m.judge_name === "goal:retired_thing")).toBe(false);
    expect(a.kpis.default_metric_count).toBe(1); // still just the catalogue default (hallucination)

    const nodeOnly = a.custom_metrics.find((m) => m.judge_name === "metric:node_only");
    expect(nodeOnly?.scope).toBe("node"); // derived from the node tag, no definition needed
    const conv = a.custom_metrics.find((m) => m.judge_name === "metric:insurance_verified");
    expect(conv?.scope).toBe("conversation"); // tagless → conversation
    expect(conv?.display_name).toBe("Insurance Verified"); // prettified fallback (no definition row)
  });
});
