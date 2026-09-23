// End-to-end Jev-first judging through the REAL event-kick path against real
// Postgres: the verdict blob, the per-judge rows and their provenance must all
// land, and the LLM must be called only where the gate said so.
//
// The Jev client is INJECTED rather than switched on with env: config is parsed
// once per process and both integration suites share it, so an env flip here
// would silently put the other suites on the Jev path too.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { describeDb, testRun } from "./helpers.js";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { MockLLM } from "../src/llm/index.js";
import { MockJev } from "../src/jev/mock.js";
import { kickEvalForSession, probeEvalTables } from "../src/evals-engine/eval-sweeper.js";
import { defaultJudgeResponder } from "../tests/fixtures/default-judge-responder.js";

const t = testRun("jev-sweep");
const agentId = t.uid("agent");
const sessionId = t.uid("sess");

const config = {
  flow_name: "orders",
  global_prompt: "Book orders.",
  nodes: [{
    ref: "node-A",
    name: "collect_order",
    instructions: "Ask for the order id and confirm it.",
    intents: [{ name: "provide_order", description: "the caller states their order id", tool: "handoff_order" }],
    variables: [{ name: "order_id", rule: "Record the order id the caller states.", tool: "record_order_id" }],
  }],
};

const rawReport = {
  events: [
    { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "assistant", content: "What is your order id?" } },
    { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "user", content: "It is 42." } },
    { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "assistant", content: "Thanks, order 42 confirmed." } },
  ],
};

const responder = (args: any) => {
  const system = args.system as string;
  if (system.includes("calibrated classifier")) {
    const asked = JSON.parse(args.user as string).defects as Array<{ id: string }>;
    return JSON.stringify({ reasons: asked.map((d) => ({ id: d.id, reason: `explained ${d.id}`, technical_reason: "t" })) });
  }
  return defaultJudgeResponder(system) ?? JSON.stringify({ detected: false, reason: "r", technical_reason: "t" });
};

describeDb("Jev-first judging through the real sweep (real PG)", () => {
  beforeAll(async () => {
    await migrate(sql);
    await t.seedAgent(agentId, t.run + "-acct");
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
    await sql`DELETE FROM ao_agents WHERE agent_id = ${agentId}`;
  });

  test("gated verdicts and their provenance land in the blob and the rows", async () => {
    // node_loop fails confidently, everything else is a confident pass.
    const jev = new MockJev([(req: any) => {
      const out: Record<string, number> = {};
      for (const key of Object.keys(req.questions)) out[key] = key.includes("node_loop") ? 0.97 : 0.01;
      return out;
    }]);
    const provider = new MockLLM([responder]);
    await probeEvalTables();
    await kickEvalForSession(sessionId, { provider, jev });

    const verdictRow = await sql`SELECT status, verdicts FROM ao_session_eval_verdicts WHERE session_id = ${sessionId}`;
    expect(verdictRow[0]?.status).toBe("done");
    const verdicts = typeof verdictRow[0].verdicts === "string" ? JSON.parse(verdictRow[0].verdicts) : verdictRow[0].verdicts;
    const node = verdicts.node_evaluations[0];
    expect(node.ref).toBe("node-A");
    expect(node.node_loop.loop_detected).toBe(true);
    expect(node.node_loop.backend).toBe("jev");
    expect(node.node_loop.confidence).toBe(0.97);
    expect(node.node_loop.reason).toBe("explained n0:node_loop");
    expect(node.hallucination.backend).toBe("jev");
    // adherence never auto-passes, so the LLM judged it
    expect(node.instructions_adherence.backend).toBe("llm");

    const rows = await sql`
      SELECT judge_name, tag, verdict, reasoning, raw FROM ao_session_external_evals
      WHERE session_id = ${sessionId} AND source = 'eval_sweeper' ORDER BY judge_name
    `;
    const byName = new Map(rows.map((r: any) => [r.judge_name, r]));
    expect(byName.get("node_loop")!.verdict).toBe("fail");
    expect(byName.get("node_loop")!.tag).toBe("node-A");
    expect(byName.get("hallucination")!.verdict).toBe("pass");
    expect(byName.get("voicemail_detection")!.verdict).toBe("pass");
    const raw = typeof byName.get("node_loop")!.raw === "string" ? JSON.parse(byName.get("node_loop")!.raw) : byName.get("node_loop")!.raw;
    expect(raw.backend).toBe("jev");
    expect(raw.confidence).toBe(0.97);
    expect(raw.jev_model).toBe("jev-mock");

    // one Jev request per purpose, and the LLM only where the gate sent it
    expect(jev.calls.map((c) => c.key).sort()).toEqual(["c", "h0", "n0", "v0"]);
    const labels = provider.calls.map((c) => c.jsonSchema?.name ?? "none").sort();
    expect(labels).toEqual(["eval_instruction", "eval_jev_reason", "eval_sentiment", "eval_stt"]);

    // idempotency: a second kick must not re-judge a done session
    const before = provider.calls.length;
    await kickEvalForSession(sessionId, { provider, jev });
    expect(provider.calls.length).toBe(before);
  });
});
