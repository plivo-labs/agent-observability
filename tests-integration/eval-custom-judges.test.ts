// End-to-end sweep with a custom judge, against real Postgres and through the
// REAL sweep loop (runEvalSweepOnce with an injected provider): seed an agent,
// a mapped custom judge, a claimable session — then prove default verdicts
// land unchanged AND the metric:* row appears, and that a re-sweep is a no-op.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { describeDb, testRun } from "./helpers.js";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { MockLLM } from "../src/llm/index.js";
import { runEvalSweepOnce } from "../src/evals-engine/eval-sweeper.js";
import { createCustomJudge, setAgentJudges } from "../src/judges/db.js";
import { customJudgeName } from "../src/evals-engine/judges/custom-metric.js";

const t = testRun("custom-sweep");
const agentId = t.uid("agent");
const sessionId = t.uid("sess");

// Content-aware responder: every default judge gets valid JSON for ITS schema,
// the custom judge fails the call.
const responder = (args: any) => {
  const s = args.system as string;
  if (s.includes("Fail if the caller was put on hold")) return JSON.stringify({ verdict: "fail", reason: "hold without warning", technical_reason: "t" });
  if (s.includes("fabricated information")) return JSON.stringify({ hallucinated: false, score: 1, reason: "", technical_reason: "" });
  if (s.includes("Variables expected to be extracted")) return JSON.stringify({ extraction_successful: true, score: 1, reason: "", technical_reason: "", missing_variables: [], incorrect_variables: [] });
  if (s.includes("repeat its own previous messages")) return JSON.stringify({ loop_detected: false, score: 1, reason: "", technical_reason: "" });
  if (s.includes("correct intent for the conversation segment")) return JSON.stringify({ intent_not_found: false, intent_wrongly_identified: false, reason: "", technical_reason: "" });
  if (s.includes("four-part rubric"))
    return JSON.stringify({
      objective_progress: { achieved: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
      procedure_compliance: { score: 1, missed_steps: [], reason_code: "", reason: "", technical_reason: "" },
      interaction_quality: { score: 1, issues: [], reason_code: "", reason: "", technical_reason: "" },
      policy_boundary_compliance: { passed: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
    });
  if (s.includes("Classify the user's sentiment")) return JSON.stringify({ sentiment: "neutral", reason: "r", technical_reason: "t" });
  if (s.includes("speech-to-text quality")) return JSON.stringify({ error_count: 0, recovered_count: 0, reason: "r", technical_reason: "t" });
  return JSON.stringify({ detected: false, reason: "r", technical_reason: "t" });
};

describeDb("custom judges through the real sweep (real PG)", () => {
  beforeAll(async () => {
    await migrate(sql);
    await t.seedAgent(agentId, t.run + "-acct");

    const judge = await createCustomJudge({
      name: customJudgeName(`${t.run} hold warning`),
      display_name: `${t.run} hold warning`,
      description: "Fail if the caller was put on hold without warning.",
      scope: "conversation",
      enabled: true,
    });
    await setAgentJudges(agentId, [{ judge_id: judge.id, enabled: true }]);

    const config = {
      flow_name: "medibook",
      global_prompt: "Book appointments.",
      nodes: [{ ref: "node-A", name: "collect_insurance", instructions: "Collect the carrier.", intents: [], variables: [] }],
    };
    const rawReport = {
      events: [
        { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "assistant", content: "Which carrier?" } },
        { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "user", content: "BlueCross. Also I was on hold forever." } },
      ],
    };
    await sql`
      INSERT INTO ao_agent_transport_sessions (
        session_id, account_id, agent_id, started_at, ended_at, duration_ms, turn_count,
        chat_history, session_metrics, raw_report, transport
      ) VALUES (
        ${sessionId}, ${t.run + "-acct"}, ${agentId},
        NOW() - interval '10 minutes', NOW() - interval '8 minutes', 120000, 2,
        '[]'::jsonb, '{}'::jsonb, ${JSON.stringify(rawReport)}::jsonb, 'livekit'
      )
    `;
    await sql`
      INSERT INTO ao_session_agent_config (session_id, config, source, created_at)
      VALUES (${sessionId}, ${JSON.stringify(config)}::jsonb, 'test', NOW() - (120 * INTERVAL '1 second'))
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM ao_session_external_evals WHERE session_id = ${sessionId}`;
    await sql`DELETE FROM ao_session_eval_verdicts WHERE session_id = ${sessionId}`;
    await sql`DELETE FROM ao_session_agent_config WHERE session_id = ${sessionId}`;
    await sql`DELETE FROM ao_agent_transport_sessions WHERE session_id = ${sessionId}`;
    await sql`DELETE FROM ao_agent_judges WHERE agent_id = ${agentId}`;
    await sql`DELETE FROM ao_judges WHERE type = 'custom' AND name LIKE ${"metric:" + t.run.replace(/-/g, "_") + "%"}`;
    await sql`DELETE FROM ao_agents WHERE agent_id = ${agentId}`;
  });

  test("defaults + the mapped custom judge land; re-sweep is a no-op; no goal rows", async () => {
    const provider = new MockLLM([responder]);
    await runEvalSweepOnce({ provider });

    const verdictRow = await sql`SELECT status, verdicts FROM ao_session_eval_verdicts WHERE session_id = ${sessionId}`;
    expect(verdictRow[0]?.status).toBe("done");
    const verdicts = typeof verdictRow[0].verdicts === "string" ? JSON.parse(verdictRow[0].verdicts) : verdictRow[0].verdicts;
    expect(verdicts.node_evaluations.length).toBe(1);
    expect(verdicts.custom_metrics.length).toBe(1);
    expect(verdicts.custom_metrics[0].verdict).toBe("fail");
    expect("goal_evaluation" in verdicts).toBe(false);

    const rows = await sql`
      SELECT judge_name, verdict FROM ao_session_external_evals
      WHERE session_id = ${sessionId} AND source = 'eval_sweeper' ORDER BY judge_name
    `;
    const byName = new Map(rows.map((r: any) => [r.judge_name, r.verdict]));
    // default node judges landed with their normal names
    expect(byName.get("instructions_adherence")).toBe("pass");
    expect(byName.get("hallucination")).toBe("pass");
    // the custom judge fanned out under its metric:* name
    const metricName = customJudgeName(`${t.run} hold warning`);
    expect(byName.get(metricName)).toBe("fail");
    // goal judging is gone
    expect([...byName.keys()].some((k) => k.startsWith("goal"))).toBe(false);

    // idempotency: a second sweep must not re-judge the done session
    const before = provider.calls.length;
    await runEvalSweepOnce({ provider });
    expect(provider.calls.length).toBe(before);
  });
});
