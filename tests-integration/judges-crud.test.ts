// Custom-judge CRUD + agent mapping against real Postgres: the create/patch/
// delete ladder, the default-judge lock, and the PUT-replace mapping semantics
// (incl. the judge-delete cascade). Query-text-level proof — the unit suite
// mocks sql, so the jsonb writes and the uuid[] literal are only proven here.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { describeDb, testRun } from "./helpers.js";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import {
  createCustomJudge,
  deleteCustomJudge,
  getJudge,
  JudgeNameConflictError,
  listAgentJudges,
  listJudges,
  setAgentJudges,
  UnknownJudgeIdsError,
  updateCustomJudge,
} from "../src/judges/db.js";
import { customJudgeName, CUSTOM_METRIC_OUT } from "../src/evals-engine/judges/custom-metric.js";

const t = testRun("judges-crud");
const run = t.run;
const agentId = t.uid("agent");

describeDb("custom judge CRUD + mapping (real PG)", () => {
  beforeAll(async () => {
    await migrate(sql);
  });
  afterAll(async () => {
    await sql`DELETE FROM ao_agent_judges WHERE agent_id = ${agentId}`;
    await sql`DELETE FROM ao_judges WHERE type = 'custom' AND name LIKE ${"metric:" + run.replace(/-/g, "_") + "%"}`;
  });

  const displayName = (suffix: string) => `${run} ${suffix}`;

  test("create stores the description as the prompt body with the fixed output section", async () => {
    const j = await createCustomJudge({
      name: customJudgeName(displayName("insurance verified")),
      display_name: displayName("insurance verified"),
      description: "Fail if slots are offered before the member ID is confirmed.",
      scope: "node",
      enabled: false,
    });
    expect(j.type).toBe("custom");
    expect(j.kind).toBe("llm");
    expect(j.name).toBe(customJudgeName(displayName("insurance verified")));
    expect(j.enabled).toBe(false); // the create body said so — column default must not win
    const raw = await sql`SELECT prompt FROM ao_judges WHERE id = ${j.id}`;
    expect(raw[0].prompt.body).toBe("Fail if slots are offered before the member ID is confirmed.");
    expect(raw[0].prompt.output).toBe(CUSTOM_METRIC_OUT);
  });

  test("duplicate name → JudgeNameConflictError", async () => {
    const name = customJudgeName(displayName("dup"));
    await createCustomJudge({ name, display_name: displayName("dup"), description: "d", scope: "conversation", enabled: false });
    await expect(
      createCustomJudge({ name, display_name: displayName("dup"), description: "d2", scope: "conversation", enabled: false }),
    ).rejects.toBeInstanceOf(JudgeNameConflictError);
  });

  test("patch updates description AND prompt body together; name never follows renames", async () => {
    const name = customJudgeName(displayName("renameme"));
    const j = await createCustomJudge({ name, display_name: displayName("renameme"), description: "old", scope: "node", enabled: false });
    const updated = await updateCustomJudge(j.id, { display_name: displayName("renamed"), description: "new criteria", enabled: true });
    expect(updated!.display_name).toBe(displayName("renamed"));
    expect(updated!.description).toBe("new criteria");
    expect(updated!.enabled).toBe(true);
    expect(updated!.name).toBe(name); // fan-out key is stable
    const raw = await sql`SELECT prompt FROM ao_judges WHERE id = ${j.id}`;
    expect(raw[0].prompt.body).toBe("new criteria");
    expect(raw[0].prompt.output).toBe(CUSTOM_METRIC_OUT);
  });

  test("default judges are locked: no update, no delete", async () => {
    const { judges } = await listJudges({ type: "default", limit: 1, offset: 0 });
    const d = judges[0]!;
    expect(await updateCustomJudge(d.id, { description: "tamper" })).toBeNull();
    expect(await deleteCustomJudge(d.id)).toBe(false);
    expect((await getJudge(d.id))!.description).not.toBe("tamper");
  });

  test("mapping: PUT-replace semantics, unknown ids rejected, delete cascades", async () => {
    const a = await createCustomJudge({ name: customJudgeName(displayName("map a")), display_name: displayName("map a"), description: "a", scope: "node", enabled: true });
    const b = await createCustomJudge({ name: customJudgeName(displayName("map b")), display_name: displayName("map b"), description: "b", scope: "conversation", enabled: true });

    let mapped = await setAgentJudges(agentId, [{ judge_id: a.id, enabled: true }, { judge_id: b.id, enabled: false }]);
    expect(mapped.map((m) => [m.id, m.mapping_enabled])).toEqual([
      [a.id, true],
      [b.id, false],
    ]);

    // replace: only b, now enabled
    mapped = await setAgentJudges(agentId, [{ judge_id: b.id, enabled: true }]);
    expect(mapped.map((m) => m.id)).toEqual([b.id]);
    expect(mapped[0]!.mapping_enabled).toBe(true);

    // a default judge id is not mappable
    const { judges } = await listJudges({ type: "default", limit: 1, offset: 0 });
    await expect(setAgentJudges(agentId, [{ judge_id: judges[0]!.id, enabled: true }])).rejects.toBeInstanceOf(
      UnknownJudgeIdsError,
    );
    // the failed PUT must not have clobbered the existing mapping (tx rollback)
    expect((await listAgentJudges(agentId)).map((m) => m.id)).toEqual([b.id]);

    // deleting the judge cascades its mapping rows
    await deleteCustomJudge(b.id);
    expect(await listAgentJudges(agentId)).toEqual([]);
  });
});

describeDb("judge dry-run test flow (real PG)", () => {
  test("getJudgeSpec + dry-run judging writes NOTHING", async () => {
    const { getJudgeSpec } = await import("../src/judges/db.js");
    const { getSessionEvalSource } = await import("../src/evals-engine/db.js");
    const { buildSessionEvalInput } = await import("../src/evals-engine/integration/session-evals.js");
    const { eventsFromChatHistory } = await import("../src/evals-engine/eval-sweeper.js");
    const { runCustomMetricJudges } = await import("../src/evals-engine/judges/custom-metric.js");
    const { MockLLM } = await import("../src/llm/index.js");

    const j = await createCustomJudge({
      name: customJudgeName(run + " dryrun"),
      display_name: run + " dryrun",
      description: "Fail if the agent was rude.",
      scope: "conversation",
      enabled: false, // drafts are testable — that is the point
    });
    const spec = (await getJudgeSpec(j.id))!;
    expect(spec.name).toBe(j.name);

    const sid = t.uid("dryrun-sess");
    await t.seedAgent(agentId, t.run + "-acct");
    await sql`
      INSERT INTO ao_agent_transport_sessions (session_id, account_id, agent_id, started_at, ended_at, duration_ms, turn_count, chat_history, session_metrics, raw_report, transport)
      VALUES (${sid}, ${t.run + "-acct"}, ${agentId}, NOW() - interval '10 minutes', NOW() - interval '8 minutes', 60000, 1,
        ${JSON.stringify([{ type: "message", role: "assistant", content: "What do you want?", node_ref: "n1" }, { type: "message", role: "user", content: "help please" }])}::text::jsonb,
        '{}'::jsonb, NULL, 'livekit')
    `;
    await sql`
      INSERT INTO ao_session_agent_config (session_id, config, source, created_at)
      VALUES (${sid}, ${JSON.stringify({ flow_name: "f", global_prompt: "g", nodes: [{ ref: "n1", name: "main", instructions: "be nice", intents: [], variables: [] }] })}::text::jsonb, 'test', NOW() - interval '2 minutes')
    `;

    const source = (await getSessionEvalSource(sid))!;
    const events = eventsFromChatHistory(source.chatHistory);
    const { input, nodeRefs } = buildSessionEvalInput(source.config as any, events);
    const llm = new MockLLM([JSON.stringify({ verdict: "fail", reason: "curt greeting", technical_reason: "t" })]);
    const [v] = await runCustomMetricJudges([spec], input, (u) => {
      const i = input.nodes.findIndex((n) => n.node_uuid === u);
      return nodeRefs[i]?.ref ?? "";
    }, llm);
    expect(v!.verdict).toBe("fail");
    expect(v!.available).toBe(true);

    // dry run: nothing persisted anywhere
    const verdictRows = await sql`SELECT 1 FROM ao_session_eval_verdicts WHERE session_id = ${sid}`;
    const evalRows = await sql`SELECT 1 FROM ao_session_external_evals WHERE session_id = ${sid}`;
    expect(verdictRows.length).toBe(0);
    expect(evalRows.length).toBe(0);

    await sql`DELETE FROM ao_session_agent_config WHERE session_id = ${sid}`;
    await sql`DELETE FROM ao_agent_transport_sessions WHERE session_id = ${sid}`;
  });
});
