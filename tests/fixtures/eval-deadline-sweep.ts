import { strict as assert } from "node:assert";
import { mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./judge-config.js";
import { defaultJudgeResponder } from "./default-judge-responder.js";
import type { LlmProvider } from "../../src/llm/types.js";

const scenario = process.argv[2];
const claims = new Map<string, { token: string; status: string }>();
const pending = ["stuck", "ready"];
const signals: AbortSignal[] = [];
const fanOut: string[] = [];
let beats = 0;
let serial = 0;
let boundedQueries = 0;
let outsideQueries = 0;
let transactions = 0;
let guardRelease: (() => void) | undefined;
let countHung = false;
let rewrites = 0;
let rollbacks = 0;

mock.module("../../src/config.js", () => ({
  ...TEST_JUDGE_CONFIG_MODULE,
  config: {
    ...TEST_JUDGE_CONFIG_MODULE.config,
    EVAL_SWEEPER: "inline", EVAL_EVENT_KICK: "on", JUDGES_FROM_DB: "off",
    EVAL_MAX_CONCURRENT_SESSIONS: 1, EVAL_MAX_CONCURRENT_KICKS: 1,
    EVAL_MAX_CONCURRENT_JUDGE_CALLS: 1, EVAL_MAX_PER_SWEEP: 2,
    EVAL_SESSION_TIMEOUT_MS: 80, EVAL_SWEEP_TIMEOUT_MS: 250, EVAL_KICK_TIMEOUT_MS: 250,
    EVAL_STATEMENT_TIMEOUT_MS: 4_000,
  },
}));

const provider: LlmProvider = {
  name: "test",
  complete: (args) => {
    if (args.user.includes("stuck")) {
      signals.push(args.signal);
      return new Promise(() => {});
    }
    const text = defaultJudgeResponder(args.system);
    assert.ok(text, "every judge must receive a valid fixture response");
    return Promise.resolve({ text, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
  },
};
mock.module("../../src/llm/providers/anthropic.js", () => ({ anthropicProvider: provider }));

const realInterval = globalThis.setInterval;
globalThis.setInterval = ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => realInterval(fn, ms === 60_000 ? 5 : ms, ...args)) as typeof setInterval;

async function query(strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]> {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  if (text.startsWith("INSERT fan-out")) {
    if (scenario === "late-insert") await new Promise<void>((resolve) => { guardRelease = resolve; });
    return [];
  }
  if (text.startsWith("SELECT set_config('statement_timeout'")) {
    assert.equal(text, "SELECT set_config('statement_timeout', ?, true)");
    assert.equal(values[0], "4000");
    boundedQueries++;
    return [];
  }
  if (text.startsWith("DELETE FROM ao_session_external_evals")) { rewrites++; return []; }
  if (scenario === "heartbeat-db" && text.startsWith("SELECT j.name") && values[0] === "stuck") return new Promise(() => {});
  if (text.includes("AS pending")) {
    if (scenario === "sweep-gate" && !countHung) {
      countHung = true;
      return new Promise(() => {});
    }
    return [{ pending: pending.length }];
  }
  if (text.includes("RETURNING session_id, claimed_at::text AS token")) {
    if (text.startsWith("UPDATE")) return [];
    if (scenario === "kick-gate" && values[0] === "stuck") return new Promise(() => {});
    const id = (text.includes("WHERE c.session_id =") ? values[0] : pending.shift()) as string | undefined;
    if (!id || claims.has(id)) return [];
    const token = String(++serial);
    claims.set(id, { token, status: "running" });
    return [{ session_id: id, token }];
  }
  if (text.startsWith("SELECT c.config")) {
    const id = String(values[0]);
    return [{ agent_id: scenario === "heartbeat-db" ? id : null, config: { nodes: [{ ref: "node", name: "help", instructions: "Help with the request." }] },
      raw_report: { events: [
        { type: "conversation_item_added", node_ref: "node", item: { type: "message", role: "assistant", content: `Can I help with ${id}?` } },
        { type: "conversation_item_added", node_ref: "node", item: { type: "message", role: "user", content: `Please help with ${id}.` } },
      ] }, tags: [], transport: "chat" }];
  }
  if (text.includes("RETURNING claimed_at::text AS token")) {
    beats++;
    const claim = claims.get(String(values[0]));
    if (!claim || claim.token !== values[1]) return [];
    claim.token = String(++serial);
    return [{ token: claim.token }];
  }
  if (text.startsWith("SELECT 1 FROM ao_session_eval_verdicts")) {
    if (scenario === "late-fan-out" && !guardRelease) await new Promise<void>((resolve) => { guardRelease = resolve; });
    const claim = claims.get(String(values[0]));
    return claim?.status === "running" && claim.token === values[1] ? [{ owned: true }] : [];
  }
  if (text.includes("SET status = 'done'") || (text.includes("SET status = 'error'") && text.includes("RETURNING session_id"))) {
    const claim = claims.get(String(values[1]));
    if (!claim || claim.token !== values[2]) return [];
    claim.status = text.includes("SET status = 'done'") ? "done" : "error";
    return [{ session_id: values[1] }];
  }
  return [];
}
const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
  outsideQueries++;
  return query(strings, ...values);
}, { begin: async (work: (tx: typeof query) => Promise<unknown>) => {
  transactions++;
  const rows: string[] = [];
  const tx: typeof query = async (...args) => {
    const result = await query(...args);
    if (args[0].join("") === "INSERT fan-out") rows.push(String(args[1]));
    return result;
  };
  try {
    const result = await work(tx);
    fanOut.push(...rows);
    return result;
  } catch (error) {
    rollbacks++;
    throw error;
  }
} });
mock.module("../../src/db.js", () => ({
  sql,
  tableExists: async () => true,
  insertLiveKitEvaluation: async (row: { sessionId: string }, tx: typeof query) => {
    await tx`INSERT fan-out${row.sessionId}`;
  },
}));

async function main(): Promise<void> {
  const { runEvalSweepOnce, fanOutExternalEvals, kickEvalForSession } = await import("../../src/evals-engine/eval-sweeper.js");
  if (scenario === "late-fan-out" || scenario === "late-insert" || scenario === "stale-fence") {
    const { withDeadline } = await import("../../src/deadline.js");
    const claim = { sessionId: "late", token: "owned" };
    claims.set(claim.sessionId, { token: claim.token, status: "running" });
    const verdicts = { node_evaluations: [], conversation_metrics: { low_engagement: { detected: false, available: true, reason: "clear" } } };
    if (scenario === "stale-fence") {
      claims.get(claim.sessionId)!.token = "new-owner";
      assert.equal(await fanOutExternalEvals(claim, verdicts as never), false);
      assert.equal(rewrites, 0);
      assert.deepEqual(fanOut, []);
      const { completeSessionEvalVerdicts, failSessionEvalVerdicts, heartbeatEvalClaim } = await import("../../src/evals-engine/db.js");
      assert.equal(await completeSessionEvalVerdicts(claim, verdicts), false);
      assert.equal(await failSessionEvalVerdicts(claim, "late failure"), false);
      assert.equal(await heartbeatEvalClaim(claim), null);
      assert.equal(claims.get(claim.sessionId)?.status, "running");
      process.exit(0);
    }
    let late: Promise<unknown> | undefined;
    await withDeadline("fan-out", 20, () => {
      late = fanOutExternalEvals(claim, verdicts as never).catch(() => "expired");
      return late;
    }).catch(() => {});
    assert.ok(guardRelease, "fan-out must reach the row lock before expiry");
    guardRelease();
    assert.equal(await late, "expired", "a row lock acquired after expiry must not permit fan-out");
    assert.deepEqual(fanOut, []);
    assert.equal(rollbacks, 1);
    if (scenario === "late-fan-out") assert.equal(rewrites, 0);
    process.exit(0);
  }
  if (scenario === "sweep-gate") {
    await runEvalSweepOnce();
    pending.splice(0, 1);
  }
  const sweep = scenario === "kick" || scenario === "kick-gate"
    ? kickEvalForSession("stuck", { provider }).then(() => kickEvalForSession("ready", { provider }))
    : runEvalSweepOnce();
  const outcome = await Promise.race([sweep.then(() => "finished"), Bun.sleep(400).then(() => "stuck")]);
  assert.equal(outcome, "finished", "a stuck provider must not latch the sweep");
  if (!["sweep-gate", "kick-gate", "heartbeat-db"].includes(scenario ?? "")) assert.ok(signals.length > 0);
  assert.ok(signals.every((signal) => signal.aborted));
  if (!["sweep-gate", "kick-gate"].includes(scenario ?? "")) assert.equal(claims.get("stuck")?.status, "running");
  assert.equal(claims.get("ready")?.status, "done");
  assert.ok(fanOut.includes("ready"));
  assert.ok(!fanOut.includes("stuck"));
  if (scenario === "heartbeat" || scenario === "heartbeat-db") {
    assert.ok(beats > 0);
    const atExpiry = beats;
    await Bun.sleep(40);
    assert.equal(beats, atExpiry, "expired sessions must stop refreshing their claims");
  }
  if (scenario === "transactions") {
    assert.ok(transactions > 1, "claim, read, heartbeat and final writes need bounded transactions");
    assert.equal(boundedQueries, transactions);
    assert.equal(outsideQueries, 0, "sweeper statements must not escape their transaction timeout");
    const { getSessionEvalSource } = await import("../../src/evals-engine/db.js");
    const before = transactions;
    await getSessionEvalSource("ready");
    assert.equal(transactions, before, "non-sweeper reads must keep using the shared pool normally");
  }
  console.log(`verified ${scenario}`);
  process.exit(0);
}
void main().catch((error) => { console.error(error); process.exit(1); });
