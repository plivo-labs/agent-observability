/**
 * Integration tests for full-text transcript search (migration 018):
 * the `transcript_text` generated column (extraction semantics — message
 * content only, tool items excluded, NULL handling) and the
 * `websearch_to_tsquery` predicate the sessions endpoint uses (stemming,
 * quoted phrases, exclusions). Runs against real Postgres because all of
 * this behavior lives in SQL.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { describeDb, testRun } from "./helpers.js";

const t = testRun("fts");

/** Chat items mirroring the real ingested shape (see spec: verified rows). */
function msg(role: "user" | "assistant", text: string) {
  return { type: "message", role, content: [text], interrupted: false };
}

async function transcriptOf(sessionId: string): Promise<string | null> {
  const rows = await sql.unsafe(
    `SELECT transcript_text FROM agent_transport_sessions WHERE session_id = $1`,
    [sessionId],
  );
  return rows[0]?.transcript_text ?? null;
}

/** The exact predicate GET /api/sessions builds for ?q= (expression must
 *  match the migration's index expression). */
async function searchIds(acct: string, q: string): Promise<string[]> {
  const rows = await sql.unsafe(
    `SELECT session_id FROM agent_transport_sessions
     WHERE account_id = $1
       AND to_tsvector('english', transcript_text) @@ websearch_to_tsquery('english', $2)
     ORDER BY ended_at DESC`,
    [acct, q],
  );
  return rows.map((r: { session_id: string }) => r.session_id);
}

describeDb("transcript_text generated column", () => {
  beforeAll(async () => {
    await migrate(sql);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  test("concatenates message content in order, newline-separated", async () => {
    const sessionId = await t.seedSession({
      accountId: t.uid("acct"),
      chatHistory: [
        msg("assistant", "Hi, thanks for calling the store."),
        msg("user", "I want to cancel my subscription."),
        msg("assistant", "I can help with that."),
      ],
    });
    expect(await transcriptOf(sessionId)).toBe(
      "Hi, thanks for calling the store.\nI want to cancel my subscription.\nI can help with that.",
    );
  });

  test("excludes tool calls, outputs, and handoffs from the transcript", async () => {
    const sessionId = await t.seedSession({
      accountId: t.uid("acct"),
      chatHistory: [
        msg("user", "Is the blue t-shirt in stock?"),
        {
          type: "function_call",
          name: "check_product_availability",
          arguments: '{"product_name":"blue t-shirt"}',
          call_id: "call-1",
        },
        { type: "function_call_output", output: "42 in stock", call_id: "call-1", is_error: false },
        { type: "agent_handoff", new_agent: "inventory" },
        msg("assistant", "Yes, we have it."),
      ],
    });
    expect(await transcriptOf(sessionId)).toBe("Is the blue t-shirt in stock?\nYes, we have it.");
  });

  test("is NULL for empty and for NULL chat_history", async () => {
    const empty = await t.seedSession({ accountId: t.uid("acct"), chatHistory: [] });
    const nul = await t.seedSession({ accountId: t.uid("acct"), chatHistory: null });
    expect(await transcriptOf(empty)).toBeNull();
    expect(await transcriptOf(nul)).toBeNull();
  });

  test("handles string-typed content (not wrapped in an array)", async () => {
    // Real ingested data carries BOTH shapes: content: ["text"] and
    // content: "text" (154 of 190 message items in the sampled local DB
    // were plain strings). Both must land in the transcript.
    const sessionId = await t.seedSession({
      accountId: t.uid("acct"),
      chatHistory: [
        { type: "message", role: "user", content: "Plain string content here." },
        msg("assistant", "Array content here."),
      ],
    });
    expect(await transcriptOf(sessionId)).toBe(
      "Plain string content here.\nArray content here.",
    );
  });

  test("multi-element content arrays contribute every fragment", async () => {
    const sessionId = await t.seedSession({
      accountId: t.uid("acct"),
      chatHistory: [
        { type: "message", role: "assistant", content: ["First fragment.", "Second fragment."] },
      ],
    });
    expect(await transcriptOf(sessionId)).toBe("First fragment.\nSecond fragment.");
  });
});

describeDb("websearch transcript matching", () => {
  let acct: string;
  let cancelled: string;
  let refund: string;
  let silent: string;

  beforeAll(async () => {
    await migrate(sql);
    acct = t.uid("acct");
    cancelled = await t.seedSession({
      accountId: acct,
      chatHistory: [msg("user", "I cancelled my subscription yesterday and want a confirmation.")],
    });
    refund = await t.seedSession({
      accountId: acct,
      chatHistory: [msg("user", "I would like a refund for my last order.")],
    });
    silent = await t.seedSession({ accountId: acct, chatHistory: null });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  test("matches single words", async () => {
    expect(await searchIds(acct, "refund")).toEqual([refund]);
  });

  test("stems: 'cancel' finds 'cancelled'", async () => {
    expect(await searchIds(acct, "cancel")).toEqual([cancelled]);
  });

  test("multi-word query requires all words, any order", async () => {
    expect(await searchIds(acct, "subscription cancel")).toEqual([cancelled]);
    expect(await searchIds(acct, "subscription refund")).toEqual([]);
  });

  test("quoted phrase matches consecutive words only", async () => {
    expect(await searchIds(acct, '"cancelled my subscription"')).toEqual([cancelled]);
    expect(await searchIds(acct, '"subscription my cancelled"')).toEqual([]);
  });

  test("minus excludes", async () => {
    const ids = await searchIds(acct, "my -refund");
    expect(ids).toContain(cancelled);
    expect(ids).not.toContain(refund);
  });

  test("sessions without transcripts never match", async () => {
    const ids = await searchIds(acct, "refund or cancel or anything");
    expect(ids).not.toContain(silent);
  });

  test("stopword-only query matches nothing", async () => {
    expect(await searchIds(acct, "the")).toEqual([]);
  });
});
