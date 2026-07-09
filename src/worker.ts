/**
 * Background-worker entrypoint — same codebase as the REST API, different
 * process. An infinite job loop: each iteration evaluates alert rules and
 * delivers due webhooks, then sleeps. No ports, no HTTP — liveness is the
 * process itself (and the sweep logs).
 *
 *   bun src/worker.ts
 *
 * Pair it with ALERT_SWEEPER=off on the API process so only one sweeper
 * burns cycles. (Running two is safe — suppression stamps and delivery
 * claims are atomic — just wasteful.)
 *
 * When the SQS consumer is configured (SIM_EVAL_SQS_QUEUE_URL + REDIS_URL +
 * LIVEKIT_SIM_TURN_URL set), this process ALSO runs the consumer that drains
 * scenario-eval messages produced by the orchestrator service and drives the turn loop. It runs
 * alongside the alert sweeper, sharing the same SIGTERM/SIGINT shutdown. Without
 * those vars the worker is sweeper-only.
 *
 * Migrations stay API-owned (AUTO_MIGRATE on the API): the worker never
 * migrates, so there is no startup race between the two entrypoints.
 * Future background jobs (rollups, retention, online judges) slot into
 * the same loop.
 */

import { config, dbConfigured } from "./config.js";
import { runSweepOnce, SWEEP_INTERVAL_MS } from "./alerts/sweeper.js";
import { startEvalSweeper, stopEvalSweeper } from "./evals-engine/eval-sweeper.js";
import { queueDispatchEnabled, simEngineConfig } from "./sim-engine/config.js";
import { consumeSimulationQueue } from "./sim-engine/queue/consumer.js";
import { makeRedis, type RedisClient } from "./sim-engine/queue/redis.js";
import { makeLiveKitSimClient } from "./sim-engine/run-engine/livekit-client.js";
import { runGoalSweepOnce } from "./goals/analyzer.js";

let running = true;

// Aborted on the first shutdown signal to stop the SQS consumer's long poll.
// Created up front (cheap, no I/O) so the signal handler can always reach it,
// whether or not the engine is wired up this run.
const consumerAbort = new AbortController();
// Held so a graceful shutdown can close the consumer's Redis connection.
let consumerRedis: RedisClient | undefined;

function shutdown(signal: string) {
  console.log(`[worker] ${signal} received — finishing current sweep, then exiting`);
  running = false;
  // Tell the SQS consumer (if running) to stop its long poll + exit its loop.
  consumerAbort.abort();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Sim-persistence table probe (aodb-write.md): the worker writes ao_sim_* rows from the
// SQS consumer, and on the managed core-DB those tables are pre-created out-of-band
// (AUTO_MIGRATE stays off — the API entrypoint owns migrations, and never against a
// shared core DB). Fail fast at boot with remediation instead of erroring per message.
if (config.SIM_PERSIST && dbConfigured) {
  const { probeSimTables } = await import("./db-probe.js");
  await probeSimTables();
}

// Start the simulation-eval SQS consumer alongside the sweeper when it's configured
// (SQS + Redis + a /turn endpoint). Otherwise the worker is sweeper-only. The promise is
// HELD (not void-ed): each poll loop finishes its in-flight scenario before honoring the
// abort, and the exit path below awaits this so a deploy's SIGTERM drains running scenarios
// instead of killing them mid-turn (which would orphan their rows at status='running' and
// hand the message back to SQS for a full re-run).
let consumerDone: Promise<void> = Promise.resolve();
if (queueDispatchEnabled) {
  consumerRedis = makeRedis();
  const livekit = makeLiveKitSimClient({
    username: simEngineConfig.livekitSimTurnUser,
    password: simEngineConfig.livekitSimTurnPass,
  });
  consumerDone = consumeSimulationQueue(
    { redis: consumerRedis, runnerDeps: { livekit } },
    {
      // queueDispatchEnabled guarantees sqsQueueUrl is set (isSimEngineEnabled checks it).
      queueUrl: simEngineConfig.sqsQueueUrl!,
      concurrency: simEngineConfig.workerConcurrency,
      signal: consumerAbort.signal,
    },
  )
    .catch((err) => console.error(`[worker] sim consumer crashed: ${(err as Error).message}`))
    .finally(() => {
      // Loop exited (clean shutdown or crash) — release the Redis connection so
      // the process can exit without a lingering open socket.
      consumerRedis?.quit().catch(() => {});
    });
} else {
  console.log("[worker] SQS consumer not configured (SQS/Redis/turn-url unset) — sweeper-only");
}

// The alert sweeper is entirely DB-backed. In STATELESS mode (no DATABASE_URL) it can't run, so the
// worker is consumer-only: it stays alive for the SQS consumer (started above) until a shutdown signal.
/** Sleep in ~1s slices so a shutdown signal is honored within a second
 *  instead of waiting out the full interval. */
async function sleepInSlices(totalMs: number): Promise<void> {
  for (let waited = 0; running && waited < totalMs; waited += 1000) {
    await Bun.sleep(1000);
  }
}

if (dbConfigured) {
  // A sim-persistence deploy points DATABASE_URL at a shared core DB that carries ONLY the
  // ao_sim_* tables — the AO-product tables (alerts, goals) deliberately don't exist there.
  // Probe once at boot instead of erroring every sweep interval; ALERT_SWEEPER=off must not
  // gate the worker (off on the API means the worker owns sweeping), so table existence is
  // the only signal that distinguishes a full AO deploy from a sim-only one.
  const { sql } = await import("./db.js");
  const [alertTables] = await sql`SELECT to_regclass('alert_rules') IS NOT NULL AS present`;
  const goalAnalyzerOn = config.GOAL_ANALYZER !== "off";
  const [goalTables] = goalAnalyzerOn
    ? await sql`SELECT to_regclass('session_goal_analyses') IS NOT NULL AS present`
    : [{ present: false }];
  const sweepAlerts = alertTables.present === true;
  const sweepGoals = goalAnalyzerOn && goalTables.present === true;
  if (!sweepAlerts) {
    console.log("[worker] alert tables absent — alert sweeper disabled (sim-only deployment)");
  }
  if (goalAnalyzerOn && !sweepGoals) {
    console.log("[worker] goal tables absent — goal analyzer disabled (sim-only deployment)");
  }
  // The eval sweep runs on its OWN timer (the shared startSweeper harness — the
  // same one the API uses in inline mode), independent of the alert/goal tables:
  // one eval tick can spend minutes on provider latency, and its internal
  // re-entrancy guard makes overlapping ticks a no-op. Gated so an inline-API
  // deployment can run this worker for alerts/SQS without doubling eval sweepers.
  if (config.EVAL_SWEEPER === "worker") {
    startEvalSweeper();
  } else {
    console.log(`[worker] EVAL_SWEEPER=${config.EVAL_SWEEPER} — this worker does not judge ingested sessions (set EVAL_SWEEPER=worker here, or "inline" on the API).`);
  }
  if (sweepAlerts || sweepGoals) {
    console.log(`[worker] started — sweeping every ${SWEEP_INTERVAL_MS / 1000}s`);
    while (running) {
      if (sweepAlerts) {
        await runSweepOnce();
      }
      // Goal analyzer rides the same loop (no-op without an LLM key); DB-backed like the sweeper.
      // Honor GOAL_ANALYZER=off so an AO deploy that is the sim/eval engine (not the goals instance)
      // doesn't run goal sweeps in the worker either — parity with the API-side inline gate.
      if (sweepGoals) {
        await runGoalSweepOnce();
      }
      await sleepInSlices(SWEEP_INTERVAL_MS);
    }
  } else {
    // DB reachable but no AO-product tables to sweep — stay alive for the SQS consumer + eval sweeper.
    while (running) {
      await Bun.sleep(1000);
    }
  }
  stopEvalSweeper(); // stop the eval timer on shutdown
} else {
  console.log("[worker] DATABASE_URL unset — stateless mode: alert sweeper disabled, consumer-only");
  while (running) {
    await Bun.sleep(1000);
  }
}

// Drain: wait for in-flight scenarios to finish before exiting (each poll loop completes its
// current message after the abort). Bounded so a wedged scenario can't stall shutdown past the
// container's stop-timeout — pick a deadline safely under typical ECS stopTimeout budgets.
const DRAIN_DEADLINE_MS = 110_000;
await Promise.race([
  consumerDone,
  Bun.sleep(DRAIN_DEADLINE_MS).then(() =>
    console.warn(`[worker] drain deadline (${DRAIN_DEADLINE_MS / 1000}s) hit — exiting with scenarios possibly in flight`),
  ),
]);

console.log("[worker] stopped");
process.exit(0);
