/**
 * Judge-verdict counters against the real claim lifecycle: a session counts
 * once, on the commit that marks it done — never on a retried commit or an
 * in-place axis re-judge.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { claimEvalSessionNow } from "../src/evals-engine/db.js";
import { commitJudgedSession, commitRejudgedVerdicts } from "../src/evals-engine/eval-sweeper.js";
import { registry } from "../src/prometheus.js";
import { describeDb, testRun } from "./helpers.js";

const t = testRun("verdictmetrics");
const det = (detected: boolean) => ({ detected, detected_value: detected ? 1 : 0, reason: "r", technical_reason: "t", available: true });
const verdicts = {
  node_evaluations: [{ ref: "n1", hallucination: { hallucinated: true, score: 0, reason: "made it up", technical_reason: "t" } }],
  conversation_metrics: {
    voicemail_detected: det(false),
    user_never_spoke: det(false),
    human_transfer: det(true),
    user_sentiment: { sentiment: "negative", reason: "r", technical_reason: "t", available: true },
  },
} as any;

async function total(name: string): Promise<number> {
  const metric = registry.getSingleMetric(name);
  return metric ? (await metric.get()).values.reduce((sum, v) => sum + v.value, 0) : 0;
}

describeDb("judge-verdict metrics count first commit only", () => {
  let sid = "";
  beforeAll(async () => {
    await migrate(sql);
    registry.resetMetrics();
    sid = await t.seedSession({ accountId: t.uid("acct"), chatHistory: [{ type: "message", role: "user", content: "hi" }] });
    await sql`
      INSERT INTO ao_session_agent_config (session_id, config, source, created_at)
      VALUES (${sid}, ${sql`${JSON.stringify({ nodes: [{ ref: "n1", name: "A" }] })}::jsonb`}, 'test', NOW())
      ON CONFLICT (session_id) DO NOTHING
    `;
  });
  afterAll(async () => {
    await sql`DELETE FROM ao_session_external_evals WHERE session_id = ${sid}`;
    await sql`DELETE FROM ao_session_eval_verdicts WHERE session_id = ${sid}`;
    await sql`DELETE FROM ao_session_agent_config WHERE session_id = ${sid}`;
    await t.cleanup();
  });

  test("first commit counts; a replayed commit and an axis re-judge do not", async () => {
    const claim = await claimEvalSessionNow(sid);
    expect(claim).not.toBeNull();

    expect(await commitJudgedSession(claim!, verdicts, new Date())).toBe(true);
    expect(await total("ao_sessions_judged_total")).toBe(1);
    expect(await total("ao_sessions_quality_failed_total")).toBe(1);
    expect(await total("ao_judge_verdicts_total")).toBe(5);
    expect(await total("ao_user_sentiment_total")).toBe(1);

    expect(await commitJudgedSession(claim!, verdicts, new Date())).toBe(false);
    expect(await commitRejudgedVerdicts(sid, verdicts, new Date())).toBe(true);
    expect(await claimEvalSessionNow(sid)).toBeNull();

    expect(await total("ao_sessions_judged_total")).toBe(1);
    expect(await total("ao_judge_verdicts_total")).toBe(5);
    expect(await total("ao_user_sentiment_total")).toBe(1);
  });
});
