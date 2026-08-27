/**
 * The invariant the sweep's drained-guard rests on.
 *
 * runEvalSweepOnce returns early when countPendingEvalSessions() is 0, instead
 * of fanning out MAX_CONCURRENT_SESSIONS workers that each re-run the claim
 * anti-join to rediscover the same thing. That is only safe if the two agree
 * exactly — if a predicate ever drifts between them (settle window, stale
 * window, the joins), the guard would silently stop judging work that
 * claimNextEvalSession would still have picked up.
 *
 * Both are pure SQL over three tables, so this needs real Postgres.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { claimNextEvalSession, countPendingEvalSessions } from "../src/evals-engine/db.js";
import { describeDb, testRun } from "./helpers.js";

const t = testRun("claimdrain");

/** Seed the eval opt-in: the sweeper only considers sessions carrying a config.
 *  `agedSeconds` backdates created_at past EVAL_CLAIM_SETTLE_SECONDS (30). */
async function seedClaimable(sessionId: string, agedSeconds = 120): Promise<void> {
  await sql`
    INSERT INTO ao_session_agent_config (session_id, config, source, created_at)
    VALUES (${sessionId}, ${sql`${JSON.stringify({ nodes: [] })}::jsonb`}, 'test',
            NOW() - (${agedSeconds} * INTERVAL '1 second'))
    ON CONFLICT (session_id) DO NOTHING
  `;
}

/** Claim until empty so the DB is in the drained state this guard targets.
 *  Bounded so a shared/dirty DB can't spin here forever. */
async function drain(max = 500): Promise<number> {
  let n = 0;
  for (; n < max; n++) {
    if (!(await claimNextEvalSession())) return n;
  }
  return n;
}

describeDb("eval claim: pending count and claimability agree", () => {
  beforeAll(async () => {
    await migrate(sql);
  });

  afterAll(async () => {
    await sql`DELETE FROM ao_session_eval_verdicts WHERE session_id LIKE ${t.run + "%"}`;
    await sql`DELETE FROM ao_session_agent_config WHERE session_id LIKE ${t.run + "%"}`;
    await t.cleanup();
  });

  test("count 0 and claim null describe the same state, in both directions", async () => {
    await drain();
    // Drained: this is the steady state the guard short-circuits.
    expect(await countPendingEvalSessions()).toBe(0);
    expect(await claimNextEvalSession()).toBeNull();

    // One claimable session must flip BOTH — a count that stays 0 here would
    // mean the guard skips real work.
    const sid = t.uid("s");
    await t.seedSession({ accountId: t.uid("acct") }).catch(() => {});
    await sql`
      INSERT INTO ao_agent_transport_sessions (session_id, account_id, created_at)
      VALUES (${sid}, ${t.uid("acct")}, NOW() - INTERVAL '2 minutes')
      ON CONFLICT (session_id) DO NOTHING
    `;
    await seedClaimable(sid);

    expect(await countPendingEvalSessions()).toBeGreaterThan(0);
    const claim = await claimNextEvalSession();
    expect(claim).not.toBeNull();

    // …and once claimed, both agree it is gone again.
    await drain();
    expect(await countPendingEvalSessions()).toBe(0);
    expect(await claimNextEvalSession()).toBeNull();
  });

  test("a session still inside the settle window is invisible to both", async () => {
    await drain();
    const sid = t.uid("young");
    await sql`
      INSERT INTO ao_agent_transport_sessions (session_id, account_id, created_at)
      VALUES (${sid}, ${t.uid("acct")}, NOW())
      ON CONFLICT (session_id) DO NOTHING
    `;
    await seedClaimable(sid, 0); // created NOW — inside the 30s settle window

    // The guard must not diverge here either: if the count saw it but the
    // claim did not, every tick would fan out 15 workers for nothing.
    expect(await countPendingEvalSessions()).toBe(0);
    expect(await claimNextEvalSession()).toBeNull();
  });
});
