/**
 * The DB seams behind the transfer-axis backfill: tags ride the eval source,
 * a done session's verdicts can be overwritten and re-fanned in place, and the
 * importer's tag lookups behave. Real Postgres — all four are plain SQL.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { findSessionIdsByTag, sql, upsertSessionTag } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import {
  getSessionEvalSource,
  getStoredSessionEvalVerdicts,
  listDoneSessionIdsWithTag,
} from "../src/evals-engine/db.js";
import { commitRejudgedVerdicts } from "../src/evals-engine/eval-sweeper.js";
import { describeDb, testRun } from "./helpers.js";

const t = testRun("transferbf");
const det = (detected: boolean) => ({ detected, detected_value: detected ? 1 : 0, reason: "r", technical_reason: "t", available: true });

describeDb("transfer-axis backfill seams", () => {
  let sid = "";
  beforeAll(async () => {
    await migrate(sql);
    sid = await t.seedSession({ accountId: t.uid("acct"), chatHistory: [{ type: "message", role: "user", content: "hi" }] });
    await sql`
      INSERT INTO ao_session_agent_config (session_id, config, source, created_at)
      VALUES (${sid}, ${sql`${JSON.stringify({ nodes: [{ ref: "n1", name: "A" }] })}::jsonb`}, 'test', NOW())
      ON CONFLICT (session_id) DO NOTHING
    `;
    await sql`
      INSERT INTO ao_session_eval_verdicts (session_id, status, verdicts, claimed_at, completed_at)
      VALUES (${sid}, 'done', ${sql`${JSON.stringify({ node_evaluations: [], conversation_metrics: { user_never_spoke: det(false) } })}::jsonb`}, NOW(), NOW())
      ON CONFLICT (session_id) DO NOTHING
    `;
    await upsertSessionTag({ sessionId: sid, name: `run_id:${t.run}`, metadata: { run_id: t.run }, source: "test", observedAt: null });
    await upsertSessionTag({ sessionId: sid, name: "transfer:human", metadata: { intent: "Transfer" }, source: "legacy_backfill", observedAt: null });
  });
  afterAll(async () => {
    await sql`DELETE FROM ao_session_external_evals WHERE session_id = ${sid}`;
    await sql`DELETE FROM ao_session_eval_verdicts WHERE session_id = ${sid}`;
    await sql`DELETE FROM ao_session_agent_config WHERE session_id = ${sid}`;
    await t.cleanup();
  });

  test("the eval source carries the session's tags with parsed metadata", async () => {
    const source = await getSessionEvalSource(sid);
    expect(source).not.toBeNull();
    const transfer = source!.tags.find((x) => x.name === "transfer:human");
    expect(transfer?.metadata).toEqual({ intent: "Transfer" });
  });

  test("findSessionIdsByTag resolves a match_tag to its session", async () => {
    expect(await findSessionIdsByTag(`run_id:${t.run}`)).toEqual([sid]);
    expect(await findSessionIdsByTag(`run_id:${t.run}-nope`)).toEqual([]);
  });

  test("listDoneSessionIdsWithTag selects by tag and by tag source", async () => {
    expect(await listDoneSessionIdsWithTag({ name: "transfer:human", tagSource: "legacy_backfill" })).toContain(sid);
    expect(await listDoneSessionIdsWithTag({ name: "transfer:human", tagSource: "some_other_source" })).not.toContain(sid);
  });

  test("listDoneSessionIdsWithTag: the name-only and since branches run too", async () => {
    expect(await listDoneSessionIdsWithTag({ name: "transfer:human" })).toContain(sid);
    expect(await listDoneSessionIdsWithTag({ name: "transfer:human", since: new Date("2000-01-01T00:00:00Z") })).toContain(sid);
    expect(await listDoneSessionIdsWithTag({ name: "transfer:human", since: new Date("2999-01-01T00:00:00Z") })).not.toContain(sid);
  });

  test("commitRejudgedVerdicts writes verdicts + rows in one transaction and keeps the rows' original created_at", async () => {
    // Seed a prior fan-out row dated a month ago — the alert engine windows on
    // created_at, so a backfill re-fan must NOT stamp old sessions into today.
    const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [{ id: priorRowId }] = await sql`
      INSERT INTO ao_session_external_evals (session_id, source, judge_name, tag, verdict, reasoning, observed_at, raw, created_at)
      VALUES (${sid}, 'eval_sweeper', 'user_never_spoke', NULL, 'pass', 'r', ${monthAgo}, '{}'::jsonb, ${monthAgo})
      RETURNING id
    `;
    const before = await getStoredSessionEvalVerdicts(sid);
    expect(before?.status).toBe("done");
    const next = {
      ...(before!.verdicts as any),
      conversation_metrics: { ...(before!.verdicts as any).conversation_metrics, human_transfer: det(true) },
    };
    expect(await commitRejudgedVerdicts(sid, next as any, monthAgo)).toBe(true);

    expect((await getStoredSessionEvalVerdicts(sid))!.verdicts).toMatchObject({ conversation_metrics: { human_transfer: { detected: true } } });
    const rows = await sql`SELECT id, judge_name, verdict, created_at FROM ao_session_external_evals WHERE session_id = ${sid} AND source = 'eval_sweeper' ORDER BY judge_name`;
    const byJudge = Object.fromEntries(rows.map((r: any) => [r.judge_name, r.verdict]));
    expect(byJudge.human_transfer).toBe("fail");
    expect(byJudge.user_never_spoke).toBe("pass");
    // Every row carries the ORIGINAL created_at, not NOW().
    for (const r of rows) {
      expect(Math.abs(new Date(r.created_at).getTime() - monthAgo.getTime())).toBeLessThan(2000);
    }
    // Rows outside the transfer axis are untouched — same physical row (same id), not a rewrite.
    const untouched = rows.find((r: any) => r.judge_name === "user_never_spoke");
    expect(untouched!.id).toBe(priorRowId);
  });

  test("commitRejudgedVerdicts refuses a session that is not done (nothing written)", async () => {
    await sql`UPDATE ao_session_eval_verdicts SET status = 'running' WHERE session_id = ${sid}`;
    const snapshot = (await getStoredSessionEvalVerdicts(sid))!.verdicts;
    expect(await commitRejudgedVerdicts(sid, { node_evaluations: [], conversation_metrics: {} as any }, new Date())).toBe(false);
    expect((await getStoredSessionEvalVerdicts(sid))!.verdicts).toEqual(snapshot);
    await sql`UPDATE ao_session_eval_verdicts SET status = 'done' WHERE session_id = ${sid}`;
  });
});
