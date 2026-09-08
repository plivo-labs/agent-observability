import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { registerJudgeRoutes } from "../src/judges/routes.js";
import { registerAnalyticsRoutes } from "../src/analytics/routes.js";
import { getAgentCustomJudges } from "../src/evals-engine/db.js";
import { calibrateMetric } from "../src/judges/ai-assist.js";
import { config } from "../src/config.js";
import { MockLLM } from "../src/llm/mock.js";
import { SessionAccessError } from "../src/account-scope.js";
import { describeDb, testRun } from "./helpers.js";

const t = testRun("judge-tenant-access");
const accountA = t.uid("account-a");
const accountB = t.uid("account-b");
const app = new Hono();
registerJudgeRoutes(app);
registerAnalyticsRoutes(app);

async function request(account: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method,
    headers: { "X-Account-Id": account, "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describeDb("judge HTTP tenant authorization", () => {
  beforeAll(async () => { await migrate(sql); });
  afterAll(async () => {
    await sql`DELETE FROM ao_judges WHERE type = 'custom' AND display_name LIKE ${t.run + "%"}`;
    await t.cleanup();
  });

  test("a caller cannot read another account's custom metric by UUID", async () => {
    const created = await request(accountA, "POST", "/api/judges", {
      display_name: t.run + " private policy", description: "Only account A may read this policy.",
      scope: "conversation", enabled: false,
    });
    expect(created.status).toBe(201);
    const judge = await created.json() as { id: string };
    expect((await request(accountA, "GET", `/api/judges/${judge.id}`)).status).toBe(200);
    const foreign = await request(accountB, "GET", `/api/judges/${judge.id}`);
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).not.toContain("Only account A");
    expect((await request(accountB, "PATCH", `/api/judges/${judge.id}`, { description: "tampered" })).status).toBe(404);
    expect((await request(accountB, "DELETE", `/api/judges/${judge.id}`)).status).toBe(404);
    expect((await request(accountA, "GET", `/api/judges/${judge.id}`)).status).toBe(200);
  });

  test("test rejects a foreign metric and mixed-account calls before evaluation", async () => {
    const created = await request(accountA, "POST", "/api/judges", {
      display_name: t.run + " test ownership", description: "Check the greeting.", scope: "conversation", enabled: false,
    });
    const judge = await created.json() as { id: string };
    const own = await t.seedSession({ accountId: accountA });
    const foreign = await t.seedSession({ accountId: accountB, chatHistory: [{ role: "user", content: ["foreign private text"] }] });
    expect((await request(accountB, "POST", `/api/judges/${judge.id}/test`, { session_ids: [foreign] })).status).toBe(404);
    expect((await request(accountA, "POST", `/api/judges/${judge.id}/test`, { session_ids: [own, foreign] })).status).toBe(404);
    expect((await request(accountA, "POST", "/api/judges/calibrate", {
      description: "Greeting policy", scope: "conversation",
      examples: [{ session_id: own, desired_verdict: "pass" }, { session_id: foreign, desired_verdict: "fail" }],
    })).status).toBe(404);
  });

  test("shared defaults remain readable and immutable for every account", async () => {
    const rows = await sql`SELECT id FROM ao_judges WHERE type = 'default' LIMIT 1`;
    const id = rows[0].id;
    for (const account of [accountA, accountB]) {
      expect((await request(account, "GET", `/api/judges/${id}`)).status).toBe(200);
      expect((await request(account, "PATCH", `/api/judges/${id}`, { description: "tampered" })).status).toBe(403);
      expect((await request(account, "DELETE", `/api/judges/${id}`)).status).toBe(403);
      const list = await (await request(account, "GET", "/api/judges?limit=200")).json() as {
        objects: Array<{ type: string; account_id: string | null }>;
      };
      expect(list.objects.every(j => j.type === "default" || j.account_id === account)).toBe(true);
    }
  });

  test("calibration sends only authorized transcripts to the model", async () => {
    const own = await t.seedSession({ accountId: accountA, chatHistory: [{ role: "user", content: ["own private text"] }] });
    const foreign = await t.seedSession({ accountId: accountB, chatHistory: [{ role: "user", content: ["foreign private text"] }] });
    const llm = new MockLLM([JSON.stringify({ description: "Refined own policy" })]);
    await expect(calibrateMetric({ description: "Policy", scope: "conversation", examples: [
      { session_id: own, desired_verdict: "pass" }, { session_id: foreign, desired_verdict: "fail" },
    ] }, llm, accountA)).rejects.toBeInstanceOf(SessionAccessError);
    expect(llm.calls).toHaveLength(0);
    await calibrateMetric({ description: "Policy", scope: "conversation", examples: [
      { session_id: own, desired_verdict: "pass" },
    ] }, llm, accountA);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.user).toContain("own private text");
    expect(llm.calls[0]!.user).not.toContain("foreign private text");
  });

  test("mapping requires both owners and trusted verification for an unseen agent", async () => {
    const agent = t.uid("new-agent");
    const otherAgent = t.uid("other-agent");
    await t.seedAgent(otherAgent, accountB);
    const create = async (account: string, suffix: string) => (await (await request(account, "POST", "/api/judges", {
      display_name: t.run + suffix, description: "Policy", scope: "conversation", enabled: false,
    })).json()) as { id: string };
    const own = await create(accountA, " own mapping");
    const foreign = await create(accountB, " foreign mapping");
    const mapping = `/api/agents/${agent}/judges`;
    expect((await request(accountA, "GET", mapping)).status).toBe(403);
    expect((await request(accountA, "PUT", mapping, { judges: [{ judge_id: own.id }] })).status).toBe(403);
    const verified = { "X-Verified-Agent-Id": agent };
    expect((await request(accountA, "PUT", mapping, { judges: [{ judge_id: own.id }] }, verified)).status).toBe(200);
    expect((await request(accountA, "PUT", mapping, { judges: [{ judge_id: foreign.id }] }, verified)).status).toBe(400);
    const after = await (await request(accountA, "GET", mapping)).json() as { objects: Array<{ id: string }> };
    expect(after.objects.map(j => j.id)).toEqual([own.id]);
    expect((await request(accountB, "GET", mapping)).status).toBe(403);
    expect((await request(accountA, "GET", `/api/agents/${otherAgent}/judges`, undefined,
      { "X-Verified-Agent-Id": otherAgent })).status).toBe(403);
  });

  test("required-scope workers quarantine legacy unowned metrics", async () => {
    const agent = t.uid("legacy-worker");
    await t.seedAgent(agent, accountA);
    const rows = await sql`INSERT INTO ao_judges (name, display_name, description, type, scope, kind, prompt, config, enabled)
      VALUES (${t.uid("custom_legacy")}, ${t.run + " legacy"}, 'Policy', 'custom', 'conversation', 'llm',
        '{"body":"Policy","output":"Return a verdict","slots":[]}'::jsonb, '{}'::jsonb, TRUE) RETURNING id`;
    await sql`INSERT INTO ao_agent_judges (agent_id, judge_id, enabled) VALUES (${agent}, ${rows[0].id}, TRUE)`;
    const previous = config.REQUIRE_ACCOUNT_SCOPE;
    try {
      config.REQUIRE_ACCOUNT_SCOPE = true;
      expect(await getAgentCustomJudges(agent, accountA)).toEqual([]);
      expect(await getAgentCustomJudges(agent, null)).toEqual([]);
      expect((await request(accountA, "GET", `/api/judges/${rows[0].id}`)).status).toBe(404);
      config.REQUIRE_ACCOUNT_SCOPE = false;
      expect(await getAgentCustomJudges(agent, accountA)).toHaveLength(1);
      expect((await request(accountA, "GET", `/api/judges/${rows[0].id}`)).status).toBe(404);
    } finally {
      config.REQUIRE_ACCOUNT_SCOPE = previous;
    }
  });

  test("same metric name in two accounts never leaks registry metadata through analytics", async () => {
    const display = t.run + " shared name";
    const create = async (account: string) => request(account, "POST", "/api/judges", {
      display_name: display, description: "Policy", scope: "conversation", enabled: true,
    });
    const a = await create(accountA);
    const b = await create(accountB);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((await create(accountA)).status).toBe(409);
    const own = await a.json() as { id: string; name: string };
    const foreign = await b.json() as { id: string };
    await request(accountB, "PATCH", `/api/judges/${foreign.id}`, { display_name: t.run + " B private title" });
    const agent = t.uid("worker-agent");
    await t.seedAgent(agent, accountA);
    // Legacy invalid mappings must not execute even before operator cleanup.
    await sql`INSERT INTO ao_agent_judges (agent_id, judge_id, enabled) VALUES
      (${agent}, ${own.id}, TRUE), (${agent}, ${foreign.id}, TRUE)`;
    const session = await t.seedSession({ accountId: accountA, agentId: agent });
    await sql`INSERT INTO ao_session_external_evals (session_id, source, judge_name, verdict)
      VALUES (${session}, 'eval_sweeper', ${own.name}, 'fail')`;
    const response = await request(accountA, "GET", `/api/analytics/metrics?account_id=${accountB}`);
    expect(response.status).toBe(200);
    const data = await response.json() as { custom_metrics: Array<{ display_name: string }> };
    expect(data.custom_metrics.map(j => j.display_name)).toEqual([display]);
    expect((await getAgentCustomJudges(agent, accountA)).map(j => j.display_name)).toEqual([display]);
    expect(await getAgentCustomJudges(agent, accountB)).toEqual([]);
  });
});
