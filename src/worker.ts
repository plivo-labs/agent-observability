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

import { dbConfigured } from "./config.js";
import { runSweepOnce, SWEEP_INTERVAL_MS } from "./alerts/sweeper.js";
import { queueDispatchEnabled, simEngineConfig } from "./sim-engine/config.js";
import { consumeSimulationQueue } from "./sim-engine/queue/consumer.js";
import { makeRedis, type RedisClient } from "./sim-engine/queue/redis.js";
import { makeLiveKitSimClient } from "./sim-engine/run-engine/livekit-client.js";

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

// Start the simulation-eval SQS consumer alongside the sweeper when it's configured
// (SQS + Redis + a /turn endpoint). Otherwise the worker is sweeper-only. Fire-and-forget:
// the consumer owns its poll loop and exits on the shared abort, so we don't await it below.
if (queueDispatchEnabled) {
  consumerRedis = makeRedis();
  const livekit = makeLiveKitSimClient({
    username: simEngineConfig.livekitSimTurnUser,
    password: simEngineConfig.livekitSimTurnPass,
  });
  void consumeSimulationQueue(
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
if (dbConfigured) {
  console.log(`[worker] started — sweeping every ${SWEEP_INTERVAL_MS / 1000}s`);
  while (running) {
    await runSweepOnce();
    // Sleep in small slices so a shutdown signal is honored within ~1s
    // instead of waiting out the full interval.
    for (let waited = 0; running && waited < SWEEP_INTERVAL_MS; waited += 1000) {
      await Bun.sleep(1000);
    }
  }
} else {
  console.log("[worker] DATABASE_URL unset — stateless mode: alert sweeper disabled, consumer-only");
  while (running) {
    await Bun.sleep(1000);
  }
}

console.log("[worker] stopped");
process.exit(0);
