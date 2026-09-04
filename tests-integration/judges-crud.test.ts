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
      accountId: "",
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
    await createCustomJudge({ accountId: "", name, display_name: displayName("dup"), description: "d", scope: "conversation", enabled: false });
    await expect(
      createCustomJudge({ name, display_name: displayName("dup"), description: "d2", scope: "conversation", enabled: false }),
    ).rejects.toBeInstanceOf(JudgeNameConflictError);
  });

  test("patch updates description AND prompt body together; name never follows renames", async () => {
    const name = customJudgeName(displayName("renameme"));
    const j = await createCustomJudge({ accountId: "", name, display_name: displayName("renameme"), description: "old", scope: "node", enabled: false });
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
    const a = await createCustomJudge({ accountId: "", name: customJudgeName(displayName("map a")), display_name: displayName("map a"), description: "a", scope: "node", enabled: true });
    const b = await createCustomJudge({ accountId: "", name: customJudgeName(displayName("map b")), display_name: displayName("map b"), description: "b", scope: "conversation", enabled: true });

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

describeDb("judge account scoping (real PG)", () => {
  test("scoped list sees defaults + own customs only; scoped writes cannot cross accounts", async () => {
    const a = await createCustomJudge({ accountId: run + "-acctA", name: customJudgeName(run + " scoped a"), display_name: run + " scoped a", description: "d", scope: "conversation", enabled: true });
    const b = await createCustomJudge({ accountId: run + "-acctB", name: customJudgeName(run + " scoped b"), display_name: run + " scoped b", description: "d", scope: "conversation", enabled: true });

    // same name in two accounts is legal (per-account uniqueness)
    const dupB = await createCustomJudge({ accountId: run + "-acctB", name: a.name, display_name: a.display_name, description: "d2", scope: "conversation", enabled: false });
    expect(dupB.name).toBe(a.name);

    const seenByA = await listJudges({ type: null, accountId: run + "-acctA", limit: 200, offset: 0 });
    const customsA = seenByA.judges.filter((j) => j.type === "custom" && j.name.includes(run.replace(/-/g, "_")));
    expect(customsA.map((j) => j.id)).toEqual([a.id]); // not b, not dupB
    expect(seenByA.judges.some((j) => j.type === "default")).toBe(true); // defaults always visible

    // cross-account write/delete blocked; own account allowed
    expect(await updateCustomJudge(b.id, { description: "tamper" }, run + "-acctA")).toBeNull();
    expect(await deleteCustomJudge(b.id, run + "-acctA")).toBe(false);
    expect(await deleteCustomJudge(b.id, run + "-acctB")).toBe(true);

    await deleteCustomJudge(a.id);
    await deleteCustomJudge(dupB.id);
  });

  test("agent-ownership fence: scoped callers cannot touch a foreign agent's mappings; unknown agents allowed", async () => {
    const { ForeignAgentError } = await import("../src/judges/db.js");
    const ownedAgent = t.uid("own-agent");
    await t.seedAgent(ownedAgent, run + "-acctA");
    const j = await createCustomJudge({ accountId: run + "-acctA", name: customJudgeName(run + " fence"), display_name: run + " fence", description: "d", scope: "conversation", enabled: true });

    // owner: fine
    await setAgentJudges(ownedAgent, [{ judge_id: j.id, enabled: true }], run + "-acctA");
    expect((await listAgentJudges(ownedAgent, run + "-acctA")).map((m) => m.id)).toEqual([j.id]);

    // foreign scoped caller: read AND write both refused
    await expect(listAgentJudges(ownedAgent, run + "-acctB")).rejects.toBeInstanceOf(ForeignAgentError);
    await expect(setAgentJudges(ownedAgent, [], run + "-acctB")).rejects.toBeInstanceOf(ForeignAgentError);

    // scoped caller cannot map another account's judge even onto its own agent
    const myAgent = t.uid("own-agent-b");
    await t.seedAgent(myAgent, run + "-acctB");
    await expect(setAgentJudges(myAgent, [{ judge_id: j.id, enabled: true }], run + "-acctB")).rejects.toBeInstanceOf(UnknownJudgeIdsError);

    // an agent AO has never seen: allowed (new flow before first call)
    const unseen = t.uid("unseen-agent");
    const mapped = await setAgentJudges(unseen, [{ judge_id: j.id, enabled: false }], run + "-acctA");
    expect(mapped.map((m) => m.id)).toEqual([j.id]);

    await sql`DELETE FROM ao_agent_judges WHERE agent_id IN (${ownedAgent}, ${unseen})`;
    await deleteCustomJudge(j.id);
  });
});
