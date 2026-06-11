/**
 * Integration test for the firing → webhook → audit → retry pipeline
 * against real Postgres AND a real in-process HTTP receiver — the unit
 * suite mocks fetch, so the wire format (method, headers, HMAC over the
 * exact body) and the persisted retry state machine are only proven here.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { runSweepOnce } from "../src/alerts/sweeper.js";
import { MAX_ATTEMPTS, RETRY_BACKOFF_MS } from "../src/alerts/deliver.js";
import { describeDb, testRun } from "./helpers.js";

const t = testRun("itd");

describeDb("webhook delivery pipeline against real Postgres + HTTP", () => {
  // Receiver state lives inside the suite so another integration file in
  // this shared process can't reach it.
  interface ReceivedRequest {
    method: string;
    headers: Record<string, string>;
    rawBody: string;
  }
  let receiver: ReturnType<typeof Bun.serve>;
  let receiverUrl = "";
  const received: ReceivedRequest[] = [];
  let respondWith = 200;

  beforeAll(async () => {
    await migrate(sql);
    receiver = Bun.serve({
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
    receiverUrl = `http://localhost:${receiver.port}/hook`;
  });

  afterAll(async () => {
    await t.cleanup();
    receiver.stop(true);
  });

  async function seedFailingEval(accountId: string): Promise<string> {
    const sessionId = await t.seedSession({ accountId });
    await t.seedEval(sessionId, "fail");
    return sessionId;
  }

  test("fires, delivers with method/headers/HMAC, and audits the attempt", async () => {
    const acct = t.uid("acct");
    const sessionId = await seedFailingEval(acct);
    const rule = await t.createRule({
      account_id: acct,
      webhook_url: receiverUrl,
      http_method: "PUT",
      secret: "it-secret",
      headers: { "x-team": "voice" },
    });

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
    expect(payload.matched_count).toBe(1); // one failing eval in the window
    expect(payload.observed_value).toBe(1); // eval_fail_rate = 100%
    expect(payload.rule.metric).toBe("eval_fail_rate");
    expect(payload.sample_session_ids).toContain(sessionId);
    expect(payload.account_id).toBe(acct);

    // Persisted state — firing delivered, attempt audited.
    const [firing] = await t.firingsFor(rule.id);
    expect(firing.status).toBe("delivered");
    expect(firing.response_status).toBe(200);
    const attempts = await sql`SELECT * FROM alert_webhook_attempts WHERE rule_id = ${rule.id}`;
    expect(attempts).toHaveLength(1);
    expect(attempts[0].ok).toBe(true);
    expect(attempts[0].kind).toBe("firing");
    expect(attempts[0].http_method).toBe("PUT");
  });

  test("schedules persisted retries on failure, then delivers on recovery", async () => {
    const acct = t.uid("acct");
    await seedFailingEval(acct);
    const rule = await t.createRule({ account_id: acct, webhook_url: receiverUrl });

    respondWith = 503;
    await runSweepOnce();

    let [firing] = await t.firingsFor(rule.id);
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

    [firing] = await t.firingsFor(rule.id);
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

  test("exhausted firings go terminally failed and are never redelivered", async () => {
    const acct = t.uid("acct");
    await seedFailingEval(acct);
    const rule = await t.createRule({ account_id: acct, webhook_url: receiverUrl });

    respondWith = 503;
    await runSweepOnce(); // creates the firing, attempt 1 fails
    const [{ id: firingId }] = await t.firingsFor(rule.id);
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      await sql`UPDATE alert_firings SET next_attempt_at = NOW() - interval '1 second' WHERE id = ${firingId}`;
      await runSweepOnce();
    }

    let [firing] = await t.firingsFor(rule.id);
    expect(firing.status).toBe("failed");
    expect(firing.attempt_count).toBe(MAX_ATTEMPTS);
    expect(firing.last_error).toBe("HTTP 503");

    // Recovery after exhaustion must NOT resurrect the firing.
    respondWith = 200;
    received.length = 0;
    await sql`UPDATE alert_firings SET next_attempt_at = NOW() - interval '1 second' WHERE id = ${firingId}`;
    await runSweepOnce();
    [firing] = await t.firingsFor(rule.id);
    expect(firing.status).toBe("failed");
    expect(firing.attempt_count).toBe(MAX_ATTEMPTS);
    expect(received.filter((r) => r.headers["x-alert-firing-id"] === firingId)).toHaveLength(0);

    const attempts = await sql`
      SELECT COUNT(*)::int AS n FROM alert_webhook_attempts WHERE firing_id = ${firingId}
    `;
    expect(attempts[0].n).toBe(MAX_ATTEMPTS); // exactly 6 audited attempts, no more
  });

  test("claims deliver oldest-due first and respect the batch limit", async () => {
    const acct = t.uid("acct");
    const rule = await t.createRule({ account_id: acct, webhook_url: receiverUrl });
    const mkFiring = async (dueMinutesAgo: number, status = "pending") => {
      const rows = await sql`
        INSERT INTO alert_firings (
          rule_id, window_start, window_end, matched_count, total_count,
          observed_value, sample_session_ids, status, next_attempt_at
        ) VALUES (
          ${rule.id}, NOW() - interval '15 minutes', NOW(), 1, 1, 1, ${[]}::jsonb,
          ${status}, NOW() - (${String(dueMinutesAgo)} || ' minutes')::interval
        ) RETURNING id
      `;
      return rows[0].id as string;
    };
    const oldest = await mkFiring(3);
    const middle = await mkFiring(2);
    const newest = await mkFiring(1);
    const failedPast = await mkFiring(5, "failed"); // terminal — never claimable
    const future = await mkFiring(-10); // not yet due

    const { claimDueFirings } = await import("../src/alerts/db.js");
    // The dev DB is shared, so claim wide and assert on our own rows only.
    const limited = await claimDueFirings(2);
    expect(limited.length).toBeLessThanOrEqual(2); // batch limit honored
    const rest = await claimDueFirings(50);
    const mine = [...limited, ...rest].filter((d) => d.rule_id === rule.id).map((d) => d.id);
    expect(mine).toEqual([oldest, middle, newest]); // oldest-due first
    expect(mine).not.toContain(failedPast); // terminal state is unclaimable
    expect(mine).not.toContain(future); // not yet due
  });

  test("the claim lease prevents a second sweep from double-delivering", async () => {
    const acct = t.uid("acct");
    await seedFailingEval(acct);
    const rule = await t.createRule({ account_id: acct, webhook_url: receiverUrl });

    respondWith = 503; // stays pending after attempt 1, leased 2 minutes out
    await runSweepOnce();
    const before = await t.firingsFor(rule.id);

    respondWith = 200;
    await runSweepOnce(); // lease not yet due — nothing to claim

    const after = await t.firingsFor(rule.id);
    expect(after[0].attempt_count).toBe(before[0].attempt_count);
    expect(after[0].status).toBe("pending");
  });
});
