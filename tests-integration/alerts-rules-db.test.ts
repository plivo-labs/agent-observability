/**
 * Integration tests for the alert-rule persistence layer — the PATCH
 * merge semantics (undefined keeps, explicit null clears) and the
 * delete cascade are real-SQL behaviors the unit suite can't prove.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { evaluateRules } from "../src/alerts/engine.js";
import {
  deleteAlertRule,
  getAlertRule,
  getWebhookStats,
  insertWebhookAttempt,
  listAlertRules,
  listWebhookAttempts,
  updateAlertRule,
} from "../src/alerts/db.js";
import { describeDb, testRun } from "./helpers.js";

const t = testRun("itr");

describeDb("alert rule persistence against real Postgres", () => {
  beforeAll(async () => {
    await migrate(sql);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  test("update keeps omitted fields and clears explicit nulls", async () => {
    const rule = await t.createRule({
      judge_name: "it_judge",
      secret: "old-secret",
      headers: { "x-team": "voice" },
    });

    const updated = await updateAlertRule(rule.id, {
      threshold_value: 0.9,
      secret: null, // explicit null clears
      // judge_name and headers omitted — must survive
    });
    expect(updated).not.toBeNull();
    expect(Number(updated!.threshold_value)).toBeCloseTo(0.9);
    expect(updated!.secret).toBeNull();
    expect(updated!.judge_name).toBe("it_judge");
    expect(updated!.headers).toEqual({ "x-team": "voice" });
  });

  test("headers round-trip as a real object through JSONB", async () => {
    const rule = await t.createRule({
      headers: { authorization: "Bearer tok", "x-a": "1" },
    });
    const fetched = await getAlertRule(rule.id);
    expect(fetched!.headers).toEqual({ authorization: "Bearer tok", "x-a": "1" });
  });

  test("listAlertRules filters by enabled and account", async () => {
    const acct = t.uid("acct");
    await t.createRule({ account_id: acct, enabled: true });
    await t.createRule({ account_id: acct, enabled: false });

    const enabledOnly = await listAlertRules(50, 0, { accountId: acct, enabled: true });
    expect(enabledOnly.totalCount).toBe(1);
    expect(enabledOnly.rules[0].enabled).toBe(true);

    const all = await listAlertRules(50, 0, { accountId: acct });
    expect(all.totalCount).toBe(2);
  });

  test("webhook stats aggregate per rule and attempts are listable filtered", async () => {
    const rule = await t.createRule({});
    const attempt = (ok: boolean) =>
      insertWebhookAttempt({
        ruleId: rule.id,
        firingId: null,
        kind: "test",
        url: "http://localhost:1/x",
        httpMethod: "POST",
        attemptNumber: 1,
        ok,
        responseStatus: ok ? 200 : 503,
        error: ok ? null : "HTTP 503",
        durationMs: 5,
      });
    await attempt(true);
    await attempt(true);
    await attempt(false);

    // Stats are global on a shared DB — assert only our rule's breakdown row.
    const stats = await getWebhookStats("24h");
    const row = stats.rule_breakdown.find((r) => r.rule_id === rule.id);
    expect(row).toBeDefined();
    expect(row!.attempts).toBe(3);
    expect(row!.accepted).toBe(2);
    expect(stats.total_attempts).toBeGreaterThanOrEqual(3);

    const { attempts, totalCount } = await listWebhookAttempts(rule.id, 50, 0);
    expect(totalCount).toBe(3);
    expect(attempts.every((a) => a.rule_id === rule.id)).toBe(true);
    expect(attempts[0].rule_name).toContain(t.run); // join carries the name
  });

  test("deleting a rule cascades to its firings and webhook attempts", async () => {
    const acct = t.uid("acct");
    const sessionId = await t.seedSession({ accountId: acct });
    await t.seedEval(sessionId, "fail");
    const rule = await t.createRule({ account_id: acct, min_samples: 1, threshold_value: 0.5 });

    await evaluateRules();
    const [firing] = await t.firingsFor(rule.id);
    expect(firing).toBeDefined();
    await insertWebhookAttempt({
      ruleId: rule.id,
      firingId: firing.id,
      kind: "firing",
      url: "http://localhost:1/x",
      httpMethod: "POST",
      attemptNumber: 1,
      ok: false,
      responseStatus: null,
      error: "test",
      durationMs: 1,
    });

    expect(await deleteAlertRule(rule.id)).toBe(true);
    expect(await t.firingsFor(rule.id)).toHaveLength(0);
    const attempts = await sql`SELECT id FROM alert_webhook_attempts WHERE rule_id = ${rule.id}`;
    expect(attempts).toHaveLength(0);
    expect(await deleteAlertRule(rule.id)).toBe(false); // already gone
  });
});
