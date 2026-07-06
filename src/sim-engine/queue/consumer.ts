// AO Simulation Engine — SQS consumer (the "dispatch adapter").
//
// Port of the reference worker `usecases/simulation_eval/simulation_eval_handler.go` (the
// `runScenario` message handler + `failScenario`), adapted to AO's thinner boundary:
// AO owns ONLY the engine (scenario turn loop + the run-level completion gate), so this
// handler does no Postgres writes and no DLQ routing — the orchestrator service persists + relays the
// :RESULTS stream, and "always complete" (delete the message) is the failure posture.
//
// The pipeline per message:
//   parse envelope → validate ids → read FLOW_JSON → parse Scenario → runScenario →
//   advance the Lua completion gate → emit simulation_completed exactly once at the gate.
//
// runScenario NEVER throws (internal failures emit scenario_completed(error) + return an
// error-shaped result), so the try/catch here is purely the panic-recovery equivalent of
// the Go `defer recover()`: an *unexpected* throw (bad envelope shape, Redis outage on the
// gate, …) still advances the gate via failScenario and is swallowed so the message is
// deleted. At-least-once redelivery is safe — the gate's SETNX fires simulation_completed
// only once even if a scenario re-runs.

import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { Message } from "@aws-sdk/client-sqs";
import { simEngineConfig } from "../config.js";
import { config, dbConfigured } from "../../config.js";
import { expectedCountKey, getFlowJson, incrementAndCheckCompletion, type RedisClient } from "./redis.js";
import { emitScenarioCompleted, emitSimulationCompleted } from "../run-engine/stream.js";
import { runScenario, type DbPersistContext, type ScenarioRunnerDeps } from "../run-engine/orchestrator.js";
import { upsertRun, finalizeRun } from "../db.js";
import { Scenario } from "../schema.js";

/** SQS receive/visibility tuning (mirrors the worker's long-poll consumer). */
// One message per receive: each worker in the pool is an independent poller that fully processes
// its message before pulling the next, so the number of concurrent scenarios is exactly the pool
// size — no in-batch fan-out to reason about, and no "wait for the whole batch" head-of-line stall.
const MAX_MESSAGES_PER_RECEIVE = 1;
const WAIT_TIME_SECONDS = 20; // long-poll: one held connection instead of a hot spin
const VISIBILITY_TIMEOUT_SECONDS = 300; // matches the message's own visibility_timeout

const EXPECTED_EVENT_NAME = "run_simulation_scenario";

/** Dependencies the handler + poll loop need; all injectable so the consumer is testable
 *  without prod wiring (a fake /turn server + a MockLLM both slot in via `runnerDeps`). */
export interface ConsumerDeps {
  /** Redis client for the gate + the :RESULTS emitters (shared with the runner). */
  redis: RedisClient;
  /** Runner deps forwarded to runScenario per message — `livekit` / `llmProvider` / `rng`
   *  are injectable here; `redis` is supplied per message from this ConsumerDeps. */
  runnerDeps?: Omit<ScenarioRunnerDeps, "redis">;
}

/** The orchestrator-service→AO SQS envelope (Body is JSON of this). Only the fields the handler reads
 *  are typed; the rest ride along untyped (`payload.body` is a loose dict by contract). */
interface SimulationEnvelope {
  event_type?: string;
  event_name?: string;
  visibility_timeout?: number;
  payload?: { body?: Record<string, unknown> };
}

/**
 * Advance the completion gate for a FAILED scenario and emit scenario_completed(error).
 * Faithful to the Go `failScenario`: even a failure advances the gate, so a run whose last
 * scenario fails still emits simulation_completed (the dashboard never hangs "in progress").
 *
 * NO ao_sim_run_scenario row is written here — deliberately mirrors the orchestrator
 * service's persist behavior, which skips the DB when a scenario_completed event carries
 * no per-execution uuid (these envelope-level drops never produced a row today either).
 * The run header IS finalized at the gate so the durable status matches the stream.
 */
async function failScenario(
  redis: RedisClient,
  simRunUuid: string,
  scenarioId: string,
  msg: string,
  dbPersist?: DbPersistContext | null,
): Promise<void> {
  await emitScenarioCompleted(redis, simRunUuid, {
    scenario_id: scenarioId,
    stop_reason: "error",
    error: msg,
  });
  const { completedByThisCall } = await incrementAndCheckCompletion(redis, simRunUuid);
  if (completedByThisCall) {
    await emitSimulationCompleted(redis, simRunUuid, {});
    if (dbPersist) {
      try {
        await finalizeRun(simRunUuid);
      } catch (err) {
        console.error(`[sim-db] finalizeRun failed (run ${simRunUuid}): ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Handle ONE SQS message body (the JSON `Body` string). Resolves on success OR on a handled
 * failure — both cases mean "delete the message". Never rethrows: an unexpected throw is
 * caught, surfaced as scenario_completed(error) via failScenario, and swallowed (the Go
 * panic-recovery equivalent) so an at-least-once redelivery storm can't wedge the queue.
 */
export async function handleSimulationMessage(deps: ConsumerDeps, bodyString: string): Promise<void> {
  const { redis } = deps;

  // ── Parse the envelope. A malformed Body is unrecoverable — log + return (deleted). We
  //    cannot call failScenario without a run uuid, so a junk message is dropped silently. ──
  let envelope: SimulationEnvelope;
  try {
    envelope = JSON.parse(bodyString) as SimulationEnvelope;
  } catch (err) {
    console.error(`[sim-consumer] dropping message with unparseable Body: ${(err as Error).message}`);
    return;
  }

  if (envelope.event_name !== EXPECTED_EVENT_NAME) {
    console.log(`[sim-consumer] ignoring event_name=${envelope.event_name ?? "<none>"} (expected ${EXPECTED_EVENT_NAME})`);
    return;
  }

  const body = envelope.payload?.body;
  if (!body || typeof body !== "object") {
    console.error("[sim-consumer] dropping message: payload.body missing");
    return;
  }

  // ── Extract + validate the required fields. simulation_run_uuid is needed for EVERY
  //    downstream emit, so without it we can't even fail the scenario — just drop. ──
  const simRunUuid = body.simulation_run_uuid;
  const scenarioId = body.scenario_id;
  const authId = body.auth_id;
  const scenarioIndex = body.scenario_index;
  const agentFlowDescription = typeof body.agent_flow_description === "string" ? body.agent_flow_description : "";

  if (typeof simRunUuid !== "string" || simRunUuid === "") {
    console.error("[sim-consumer] dropping message: simulation_run_uuid missing/invalid");
    return;
  }
  if (typeof scenarioId !== "string" || scenarioId === "") {
    console.error(`[sim-consumer] dropping message (run ${simRunUuid}): scenario_id missing/invalid`);
    return;
  }
  if (typeof authId !== "string" || authId === "") {
    console.error(`[sim-consumer] dropping message (run ${simRunUuid}): auth_id missing/invalid`);
    return;
  }
  if (typeof scenarioIndex !== "number" || !Number.isFinite(scenarioIndex)) {
    console.error(`[sim-consumer] dropping message (run ${simRunUuid}): scenario_index missing/invalid`);
    return;
  }

  // ── Durable persistence context (aodb-write.md). `agent_id` is the opaque caller-supplied
  //    agent identifier; `auth_id` doubles as the tenant. Persistence is gated ONLY on
  //    SIM_PERSIST && dbConfigured (never migration state) + the message actually carrying
  //    agent_id — a legacy message without it runs fine, it just isn't persisted. ──
  const agentId = typeof body.agent_id === "string" && body.agent_id !== "" ? body.agent_id : null;
  const dbPersist: DbPersistContext | null =
    config.SIM_PERSIST && dbConfigured && agentId ? { tenantId: authId, agentId } : null;
  if (config.SIM_PERSIST && dbConfigured && !agentId) {
    console.warn(`[sim-db] run ${simRunUuid}: agent_id missing from message — skipping DB persistence for this scenario`);
  }
  // Durable scenario reference: the library row uuid when the sender supplies one (globally
  // unique), else the scenario JSONB id (unique only within a generation). Events always echo
  // scenario_id; this only affects what ao_sim_run_scenario.scenario_ref stores.
  const scenarioRef =
    typeof body.scenario_uuid === "string" && body.scenario_uuid !== "" ? body.scenario_uuid : scenarioId;

  // From here on we HAVE a run uuid + scenario id — every failure routes through
  // failScenario so the gate advances and simulation_completed still fires.
  // Emits go straight to the live Redis :RESULTS stream (the managed deployment; the orchestrator service relays it).
  try {
    // ── Idempotent run-header upsert (first message of the run inserts; the rest no-op).
    //    Placed BEFORE any failure path so even an all-failed run has a durable header. A DB
    //    error here downgrades to unpersisted (log) — persistence never blocks the run. ──
    if (dbPersist) {
      try {
        let scenarioCount = typeof body.scenario_count === "number" ? body.scenario_count : null;
        if (scenarioCount == null) {
          const raw = await redis.get(expectedCountKey(simRunUuid)).catch(() => null);
          scenarioCount = raw != null ? Number(raw) || 0 : 0;
        }
        await upsertRun({
          id: simRunUuid,
          tenantId: dbPersist.tenantId,
          agentId: dbPersist.agentId,
          name: typeof body.run_name === "string" ? body.run_name : null,
          scenarioCount,
          maxTurns: typeof body.max_turns === "number" ? body.max_turns : 25,
        });
      } catch (err) {
        console.error(`[sim-db] upsertRun failed (run ${simRunUuid}): ${(err as Error).message}`);
      }
    }
    // ── Read the flow JSON the orchestrator service seeded for this run. A miss is fatal for the scenario
    //    (we can't run the flow), but not for the run — fail the scenario, advance the gate. ──
    let flowJson: string;
    try {
      flowJson = await getFlowJson(redis, simRunUuid);
    } catch (err) {
      console.error(`[sim-consumer] run ${simRunUuid} scenario ${scenarioId}: ${(err as Error).message}`);
      await failScenario(redis, simRunUuid, scenarioId, "failed to retrieve flow JSON", dbPersist);
      return;
    }

    // ── Parse the inline scenario dict. A bad shape fails just this scenario. ──
    const parsed = Scenario.safeParse(body.scenario);
    if (!parsed.success) {
      console.error(`[sim-consumer] run ${simRunUuid} scenario ${scenarioId}: scenario deserialize failed — ${parsed.error.message}`);
      await failScenario(redis, simRunUuid, scenarioId, "failed to deserialize scenario", dbPersist);
      return;
    }
    const scenario = parsed.data;

    // ── Run the scenario end-to-end (never throws; emits its own scenario_started →
    //    turn_completed* → scenario_completed). maxTurns defaults defensively to 25. ──
    await runScenario(
      { redis, ...deps.runnerDeps },
      {
        simRunUuid,
        scenarioId,
        scenarioIndex,
        scenario,
        authId,
        agentFlowDescription,
        flowJson,
        maxTurns: scenario.max_turns ?? 25,
        dbPersist,
        scenarioRef,
      },
    );

    // ── Advance the run-level completion gate; the single call that reaches the expected
    //    count emits simulation_completed (SETNX inside the Lua makes this exactly-once). ──
    const { processed, completedByThisCall } = await incrementAndCheckCompletion(redis, simRunUuid);
    if (completedByThisCall) {
      await emitSimulationCompleted(redis, simRunUuid, { scenarios_processed: processed });
      if (dbPersist) {
        try {
          await finalizeRun(simRunUuid);
        } catch (err) {
          console.error(`[sim-db] finalizeRun failed (run ${simRunUuid}): ${(err as Error).message}`);
        }
      }
    }
  } catch (err) {
    // Panic-recovery equivalent: runScenario + the gate shouldn't throw, but if anything
    // does (e.g. Redis blip on the gate), fail the scenario so the gate still advances and
    // swallow the error so the message is deleted ("always complete").
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sim-consumer] run ${simRunUuid} scenario ${scenarioId}: unexpected error — ${message}`);
    try {
      await failScenario(redis, simRunUuid, scenarioId, `panic: ${message}`, dbPersist);
    } catch (failErr) {
      // Even failScenario failed (Redis fully down). Nothing left to do but log + delete.
      console.error(`[sim-consumer] run ${simRunUuid} scenario ${scenarioId}: failScenario also failed — ${(failErr as Error).message}`);
    }
  }
}

/** Options for the consumer. */
export interface ConsumeOptions {
  /** SQS queue URL to drain. */
  queueUrl: string;
  /** Number of independent worker loops = max scenarios processed concurrently (the fan-out). */
  concurrency: number;
  /** Abort to stop every worker cleanly (wired to SIGTERM/SIGINT in the worker). */
  signal: AbortSignal;
  /** Injectable SQS client (tests pass one pointed at ElasticMQ; prod builds one from config). */
  sqs?: SQSClient;
}

/**
 * One autonomous worker: long-poll receive → handle → delete → repeat, until the signal aborts.
 * Running `concurrency` of these against a shared SQS + Redis client is the fan-out — the direct
 * analogue of cx-sqs-worker's N independent worker goroutines (poller.go StartWorkers). Because
 * each worker polls independently, N scenarios stay in flight regardless of how SQS batches
 * deliveries (SQS often returns 1 message per receive for a small queue), and a slow scenario in
 * one worker never blocks the others — the head-of-line stall of the old single batch-blocking
 * loop is gone.
 *
 * handleSimulationMessage never rethrows (it always means "delete"), so a throw reaching here is a
 * genuine infra fault (e.g. the DeleteMessage call) — log it and leave the message for redelivery
 * rather than deleting work that didn't complete. At-least-once redelivery is safe: the run-level
 * Lua gate (SETNX) fires simulation_completed exactly once even if a scenario re-runs.
 */
async function runWorkerLoop(
  deps: ConsumerDeps,
  sqs: SQSClient,
  queueUrl: string,
  signal: AbortSignal,
  workerId: number,
): Promise<void> {
  while (!signal.aborted) {
    let messages: Message[];
    try {
      const out = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: MAX_MESSAGES_PER_RECEIVE,
          WaitTimeSeconds: WAIT_TIME_SECONDS,
          VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
        }),
        // Abort the in-flight long poll the instant we're asked to shut down.
        { abortSignal: signal },
      );
      messages = out.Messages ?? [];
    } catch (err) {
      if (signal.aborted) break; // the abort cancelled the receive — clean exit
      // Transient SQS error: log + back off briefly so we don't hot-spin on a persistent fault.
      console.error(`[sim-consumer] worker ${workerId} ReceiveMessage failed: ${(err as Error).message}`);
      await Bun.sleep(1000);
      continue;
    }

    for (const msg of messages) {
      if (!msg.Body || !msg.ReceiptHandle) continue; // SQS guarantees both on a real message
      try {
        await handleSimulationMessage(deps, msg.Body);
        // Handler resolved → "complete" → delete so it isn't redelivered.
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: msg.ReceiptHandle }));
      } catch (err) {
        // handleSimulationMessage never rethrows, so reaching here means the DeleteMessage call
        // failed. Don't delete — let the visibility timeout lapse + SQS redeliver.
        console.error(`[sim-consumer] worker ${workerId} failed to delete message ${msg.MessageId ?? "<unknown>"}: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Drain the queue with a fixed pool of `concurrency` independent worker loops (see runWorkerLoop),
 * all sharing one SQS + Redis client. Returns when every worker has exited on the shared abort
 * signal. The 20s WaitTimeSeconds bounds shutdown latency: each in-flight receive cancels on abort
 * (or returns within ~20s), then that worker's `signal.aborted` check exits.
 */
export async function consumeSimulationQueue(deps: ConsumerDeps, opts: ConsumeOptions): Promise<void> {
  const { queueUrl, concurrency, signal } = opts;
  const sqs = opts.sqs ?? new SQSClient({ region: simEngineConfig.awsRegion });
  const poolSize = Math.max(1, concurrency);

  console.log(`[sim-consumer] started — draining ${queueUrl} with ${poolSize} workers`);

  await Promise.all(
    Array.from({ length: poolSize }, (_, i) => runWorkerLoop(deps, sqs, queueUrl, signal, i)),
  );

  console.log("[sim-consumer] stopped");
}
