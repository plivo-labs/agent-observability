/* live.ts — async state machine for REAL Live calls placed via Truman.
 *
 * createLiveSuite() provisions Truman entities + a suite and records local
 * rows; reconcileSuite() pulls each Truman run's status/verdict/transcript and,
 * once every call is terminal, persists the suite as one eval_run (so it lands
 * in the Evals tab exactly like the demo path). The frontend polls the suite;
 * startLiveReconciler() also sweeps in the background so completion + eval
 * persistence don't depend on a client staying connected. */
import { randomUUID } from "crypto";
import { sql, insertSession } from "../db.js";
import type { CallResult, Criterion } from "./engine.js";
import { persistCallBatch } from "./persist.js";
import { buildMonitorChatHistory, getRun, isTerminal, mapRun, provisionSuite } from "./truman.js";

const TIMEOUT_MS = 15 * 60 * 1000; // give up on an unreachable run after 15 min
const parseJson = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

export interface LiveCall extends CallResult { status: string; recordingUrl: string | null; error: string | null; sessionId: string | null }
export interface LiveSuite {
  suiteId: string; agentName: string; mode: "truman"; status: string;
  evalRunId: string | null; calls: LiveCall[];
}

/** Provision Truman entities + a suite from AO Library selections, record rows. */
export async function createLiveSuite(input: {
  prompt: string; phoneNumber: string; personas: any[]; criteria: Criterion[]; opener?: string;
  rubricId?: string; rubricName?: string;
}): Promise<LiveSuite> {
  const provisioned = await provisionSuite(input);
  const suiteId = randomUUID();
  await sql`
    INSERT INTO sim_live_suites (id, agent_name, prompt, phone_number, truman_suite_id, status)
    VALUES (${suiteId}, ${provisioned.agentName}, ${input.prompt}, ${input.phoneNumber}, ${provisioned.trumanSuiteId}, 'running')`;
  let i = 0;
  for (const r of provisioned.runs) {
    const p = r.persona ?? {};
    await sql`
      INSERT INTO sim_live_calls (id, suite_id, call_index, persona_name, persona_type, avatar, opener, truman_run_id, status)
      VALUES (${randomUUID()}, ${suiteId}, ${i}, ${String(p.name ?? "Caller")}, ${String(p.type ?? "baseline")},
              ${String(p.avatar ?? "#6366f1")}, ${input.opener?.trim() || p.opener || ""}, ${r.trumanRunId}, 'queued')`;
    i++;
  }
  const created = await getLiveSuite(suiteId);
  if (!created) throw new Error("suite row vanished after insert");
  return created;
}

/** Read the current suite state (no Truman calls) in the frontend's shape. */
export async function getLiveSuite(suiteId: string): Promise<LiveSuite | null> {
  const [suite] = await sql`SELECT * FROM sim_live_suites WHERE id = ${suiteId}`;
  if (!suite) return null;
  const rows = await sql`SELECT * FROM sim_live_calls WHERE suite_id = ${suiteId} ORDER BY call_index ASC`;
  return {
    suiteId,
    agentName: suite.agent_name,
    mode: "truman",
    status: suite.status,
    evalRunId: suite.eval_run_id ?? null,
    calls: rows.map((r: any) => rowToLiveCall(r, suite.agent_name)),
  };
}

function rowToLiveCall(r: any, agentName: string): LiveCall {
  const verdict = r.verdict === "pass" ? "pass" : "fail";
  return {
    engine: "real",
    agentName,
    personaName: r.persona_name,
    personaType: r.persona_type,
    avatar: r.avatar,
    opener: r.opener ?? "",
    transcript: parseJson(r.transcript) ?? [],
    verdict,
    judge: parseJson(r.judge) ?? { criteria: [], overall: verdict, notes: r.error ?? "" },
    cost: parseJson(r.cost) ?? { llm_tokens: 0, tts_chars: 0, stt_seconds: 0, call_seconds: r.duration_s ?? 0, cents: 0 },
    durationS: r.duration_s ?? 0,
    trumanRunId: r.truman_run_id ?? undefined,
    status: r.status,
    recordingUrl: r.recording_url ?? null,
    error: r.error ?? null,
    sessionId: r.session_id ?? null,
  };
}

/** Pull each non-terminal run from Truman, update rows, persist when all done. */
export async function reconcileSuite(suiteId: string): Promise<LiveSuite | null> {
  const [suite] = await sql`SELECT * FROM sim_live_suites WHERE id = ${suiteId}`;
  if (!suite) return null;
  if (suite.status === "done" || suite.status === "failed") return getLiveSuite(suiteId);

  const rows = await sql`SELECT * FROM sim_live_calls WHERE suite_id = ${suiteId} ORDER BY call_index ASC`;
  const ageMs = Date.now() - new Date(suite.created_at).getTime();

  for (const r of rows) {
    if (isTerminal(r.status)) continue;
    try {
      const run = await getRun(r.truman_run_id);
      const m = mapRun(run);
      if (!isTerminal(m.status) && ageMs > TIMEOUT_MS) {
        // Run never progressed (e.g. the Truman caller worker isn't running).
        await sql`UPDATE sim_live_calls SET status = 'failed', verdict = 'fail', error = ${"timed out — the call never progressed (is the Truman caller worker running?)"}, updated_at = NOW() WHERE id = ${r.id}`;
      } else {
        await sql`
          UPDATE sim_live_calls SET
            status = ${m.status}, verdict = ${m.verdict},
            judge = ${m.judge ?? null}::jsonb, transcript = ${m.transcript}::jsonb, cost = ${m.cost}::jsonb,
            duration_s = ${m.durationS}, recording_url = ${m.recordingUrl}, error = ${m.error}, updated_at = NOW()
          WHERE id = ${r.id}`;
        // On reaching a terminal state, materialize a Monitor session from the
        // caller agent's LiveKit per-turn metrics and link it. Best-effort —
        // must never fail the suite (per the fire-and-forget reconcile rule).
        if (isTerminal(m.status) && m.sessionChatHistory?.length && !r.session_id) {
          try {
            const sessionId = randomUUID();
            const chatHistory = buildMonitorChatHistory(m.sessionChatHistory);
            const turnCount = chatHistory.filter((i) => i.role === "assistant").length;
            await insertSession({
              sessionId, accountId: null, transport: "phone",
              startedAt: m.startedAt ? new Date(m.startedAt) : null,
              endedAt: m.endedAt ? new Date(m.endedAt) : new Date(),
              durationMs: (m.durationS || 0) * 1000, turnCount,
              hasStt: true, hasLlm: true, hasTts: true,
              chatHistory, sessionMetrics: m.sessionMetrics, rawReport: null,
              recordUrl: m.recordingUrl,
            });
            await sql`UPDATE sim_live_calls SET session_id = ${sessionId} WHERE id = ${r.id}`;
          } catch (e) {
            console.error(`[live] monitor session create failed for call ${r.id}: ${(e as Error).message}`);
          }
        }
      }
    } catch (e) {
      // Truman unreachable / run errored. Retry next tick; give up past the timeout.
      if (ageMs > TIMEOUT_MS) {
        await sql`UPDATE sim_live_calls SET status = 'failed', verdict = 'fail', error = ${`unreachable: ${(e as Error).message}`}, updated_at = NOW() WHERE id = ${r.id}`;
      }
    }
  }

  // Recompute and, if everything is terminal, persist the suite once.
  const updated = await sql`SELECT * FROM sim_live_calls WHERE suite_id = ${suiteId} ORDER BY call_index ASC`;
  const allTerminal = updated.length > 0 && updated.every((r: any) => isTerminal(r.status));
  if (allTerminal) {
    const calls: CallResult[] = updated.map((r: any) => {
      const lc = rowToLiveCall(r, suite.agent_name);
      const { status, recordingUrl, error, sessionId, ...cr } = lc; // CallResult shape for persistence
      return cr;
    });
    let evalRunId: string | null = null;
    try { evalRunId = await persistCallBatch(suite.agent_name, calls); } catch (e) {
      console.error(`[live] persist failed for suite ${suiteId}: ${(e as Error).message}`);
    }
    await sql`UPDATE sim_live_suites SET status = 'done', eval_run_id = ${evalRunId}, updated_at = NOW() WHERE id = ${suiteId}`;
    console.log(`[live] suite ${suiteId} done — ${calls.filter((c) => c.verdict === "pass").length}/${calls.length} passed${evalRunId ? ` → eval ${evalRunId}` : ""}`);
  }
  return getLiveSuite(suiteId);
}

/** Background sweep so suites finish + persist even if no client is polling. */
let running = false;
export function startLiveReconciler() {
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const due = await sql`SELECT id FROM sim_live_suites WHERE status NOT IN ('done', 'failed') ORDER BY created_at ASC LIMIT 10`;
      for (const d of due) {
        try { await reconcileSuite(d.id); } catch (e) { console.error(`[live] reconcile ${d.id} failed: ${(e as Error).message}`); }
      }
    } catch (e) {
      // table may not exist yet on a fresh boot before migration; ignore.
    } finally { running = false; }
  }, 10_000);
}
