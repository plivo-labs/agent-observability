/**
 * Integration test for the firing → webhook → audit → retry pipeline
 * against real Postgres AND a real in-process HTTP receiver — the unit
 * suite mocks fetch, so the wire format (method, headers, HMAC over the
 * exact body) and the persisted retry state machine are only proven here.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { runSweepOnce } from "../src/alerts/sweeper.js";
import { insertAlertRule } from "../src/alerts/db.js";
import { RETRY_BACKOFF_MS } from "../src/alerts/deliver.js";
import type { AlertRuleCreate } from "../src/alerts/schema.js";

const RUN = `itd-${Date.now().toString(36)}`;

let dbUp = true;
try {
  await sql`SELECT 1`;
} catch {
  dbUp = false;
  console.warn("[integration] DATABASE_URL unreachable — skipping delivery suite");
}
const d = dbUp ? describe : describe.skip;

// ── In-process webhook receiver ─────────────────────────────────────────────

interface ReceivedRequest {
  method: string;
  headers: Record<string, string>;
  rawBody: string;
}

const received: ReceivedRequest[] = [];
let respondWith = 200;

const receiver = Bun.serve({
  port: 0, // OS-assigned — no collisions with dev servers
  async fetch(req) {
    received.push({
      method: req.method,
      headers: Object.fromEntries(req.headers.entries()),
      rawBody: await req.text(),
    });
    return new Response("", { status: respondWith });
  },
});
const RECEIVER_URL = `http://localhost:${receiver.port}/hook`;

// ── Helpers ─────────────────────────────────────────────────────────────────

let seq = 0;
const uid = (tag: string) => `${RUN}-${tag}-${++seq}`;

async function seedFailingEval(accountId: string): Promise<string> {
  const sessionId = uid("sess");
  await sql`
    INSERT INTO agent_transport_sessions (session_id, account_id, started_at, ended_at, duration_ms, turn_count, chat_history, session_metrics)
    VALUES (${sessionId}, ${accountId}, NOW() - interval '2 minutes', NOW(), 120000, 1, '[]'::jsonb, '{}'::jsonb)
  `;
  await sql`
    INSERT INTO session_external_evals (session_id, source, judge_name, verdict)
    VALUES (${sessionId}, ${RUN}, 'it_judge', 'fail')
  `;
  return sessionId;
}

function countRule(over: Partial<AlertRuleCreate> & { account_id: string }): AlertRuleCreate {
  return {
    name: `${RUN} rule`,
    enabled: true,
    agent_id: null,
    metric: null,
    judge_name: null,
    trigger_type: "evaluation_count",
    verdicts: ["fail"],
    threshold_count: 1,
    threshold_value: null,
    min_samples: 1,
    window_minutes: 15,
    webhook_url: RECEIVER_URL,
    http_method: "POST",
    secret: null,
    headers: null,
    ...over,
  } as AlertRuleCreate;
}

d("webhook delivery pipeline against real Postgres + HTTP", () => {
  beforeAll(async () => {
    await migrate(sql);
  });

  afterAll(async () => {
    await sql`DELETE FROM alert_rules WHERE name LIKE ${RUN + "%"}`;
    await sql`DELETE FROM session_external_evals WHERE source = ${RUN}`;
    await sql`DELETE FROM agent_transport_sessions WHERE account_id LIKE ${RUN + "%"}`;
    receiver.stop(true);
    // NOTE: never close the shared sql pool here — both integration files
    // run in one bun process and the second file still needs it.
  });

  test("fires, delivers with method/headers/HMAC, and audits the attempt", async () => {
    const acct = uid("acct");
    const sessionId = await seedFailingEval(acct);
    const rule = await insertAlertRule(
      countRule({
        account_id: acct,
        http_method: "PUT",
        secret: "it-secret",
        headers: { "x-team": "voice" },
      }),
    );

    respondWith = 200;
    received.length = 0;
    await runSweepOnce();

    // Wire format — method, custom header, signature over the exact body.
    const mine = received.filter((r) => r.headers["x-alert-rule-id"] === rule.id);
    expect(mine).toHaveLength(1);
    const req = mine[0];
    expect(req.method).toBe("PUT");
    expect(req.headers["x-team"]).toBe("voice");
    expect(req.headers["content-type"]).toBe("application/json");
    const expectedSig = `sha256=${createHmac("sha256", "it-secret").update(req.rawBody).digest("hex")}`;
    expect(req.headers["x-alert-signature"]).toBe(expectedSig);

    const payload = JSON.parse(req.rawBody);
    expect(payload.type).toBe("alert.triggered");
    expect(payload.rule.id).toBe(rule.id);
    expect(payload.matched_count).toBe(1);
    expect(payload.sample_session_ids).toContain(sessionId);
    expect(payload.account_id).toBe(acct);

    // Persisted state — firing delivered, attempt audited.
    const [firing] = await sql`SELECT * FROM alert_firings WHERE rule_id = ${rule.id}`;
    expect(firing.status).toBe("delivered");
    expect(firing.response_status).toBe(200);
    const attempts = await sql`SELECT * FROM alert_webhook_attempts WHERE rule_id = ${rule.id}`;
    expect(attempts).toHaveLength(1);
    expect(attempts[0].ok).toBe(true);
    expect(attempts[0].kind).toBe("firing");
    expect(attempts[0].http_method).toBe("PUT");
  });

  test("schedules persisted retries on failure, then delivers on recovery", async () => {
    const acct = uid("acct");
    await seedFailingEval(acct);
    const rule = await insertAlertRule(countRule({ account_id: acct }));

    respondWith = 503;
    await runSweepOnce();

    let [firing] = await sql`SELECT * FROM alert_firings WHERE rule_id = ${rule.id}`;
    expect(firing.status).toBe("pending");
    expect(firing.attempt_count).toBe(1);
    expect(firing.response_status).toBe(503);
    // First backoff lands the retry ~RETRY_BACKOFF_MS[0] out.
    const delayMs = new Date(firing.next_attempt_at).getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(RETRY_BACKOFF_MS[0] - 10_000);
    expect(delayMs).toBeLessThanOrEqual(RETRY_BACKOFF_MS[0] + 10_000);

    // Receiver recovers; force the retry due (simulating elapsed backoff —
    // exactly the state a process restart would resume from).
    respondWith = 200;
    await sql`UPDATE alert_firings SET next_attempt_at = NOW() - interval '1 second' WHERE id = ${firing.id}`;
    await runSweepOnce();

    [firing] = await sql`SELECT * FROM alert_firings WHERE rule_id = ${rule.id}`;
    expect(firing.status).toBe("delivered");
    expect(firing.attempt_count).toBe(2);

    const attempts = await sql`
      SELECT ok, response_status, attempt_number FROM alert_webhook_attempts
      WHERE rule_id = ${rule.id} ORDER BY created_at
    `;
    expect(attempts).toHaveLength(2);
    expect(attempts[0].ok).toBe(false);
    expect(attempts[0].response_status).toBe(503);
    expect(attempts[1].ok).toBe(true);
    expect(attempts[1].attempt_number).toBe(2);
  });

  test("the claim lease prevents a second sweep from double-delivering", async () => {
    const acct = uid("acct");
    await seedFailingEval(acct);
    const rule = await insertAlertRule(countRule({ account_id: acct }));

    respondWith = 503; // stays pending after attempt 1, leased 2 minutes out
    await runSweepOnce();
    const before = await sql`SELECT attempt_count FROM alert_firings WHERE rule_id = ${rule.id}`;

    respondWith = 200;
    await runSweepOnce(); // lease not yet due — nothing to claim

    const after = await sql`SELECT attempt_count, status FROM alert_firings WHERE rule_id = ${rule.id}`;
    expect(after[0].attempt_count).toBe(before[0].attempt_count);
    expect(after[0].status).toBe("pending");
  });
});
