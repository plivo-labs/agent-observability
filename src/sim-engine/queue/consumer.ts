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
import { getFlowJson, incrementAndCheckCompletion, type RedisClient } from "./redis.js";
import { emitScenarioCompleted, emitSimulationCompleted } from "../run-engine/stream.js";
import { runScenario, type ScenarioRunnerDeps } from "../run-engine/orchestrator.js";
import { Scenario } from "../schema.js";

/** SQS receive/visibility tuning (mirrors the worker's long-poll consumer). */
const MAX_MESSAGES_PER_RECEIVE = 10;
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
 */
async function failScenario(
  redis: RedisClient,
  simRunUuid: string,
  scenarioId: string,
  msg: string,
): Promise<void> {
  await emitScenarioCompleted(redis, simRunUuid, {
    scenario_id: scenarioId,
    stop_reason: "error",
    error: msg,
  });
  const { completedByThisCall } = await incrementAndCheckCompletion(redis, simRunUuid);
  if (completedByThisCall) {
    await emitSimulationCompleted(redis, simRunUuid, {});
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

  // From here on we HAVE a run uuid + scenario id — every failure routes through
  // failScenario so the gate advances and simulation_completed still fires.
  // Emits go straight to the live Redis :RESULTS stream (the managed deployment; the orchestrator service relays it).
  try {
    // ── Read the flow JSON the orchestrator service seeded for this run. A miss is fatal for the scenario
    //    (we can't run the flow), but not for the run — fail the scenario, advance the gate. ──
    let flowJson: string;
    try {
      flowJson = await getFlowJson(redis, simRunUuid);
    } catch (err) {
      console.error(`[sim-consumer] run ${simRunUuid} scenario ${scenarioId}: ${(err as Error).message}`);
      await failScenario(redis, simRunUuid, scenarioId, "failed to retrieve flow JSON");
      return;
    }

    // ── Parse the inline scenario dict. A bad shape fails just this scenario. ──
    const parsed = Scenario.safeParse(body.scenario);
    if (!parsed.success) {
      console.error(`[sim-consumer] run ${simRunUuid} scenario ${scenarioId}: scenario deserialize failed — ${parsed.error.message}`);
      await failScenario(redis, simRunUuid, scenarioId, "failed to deserialize scenario");
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
      },
    );

    // ── Advance the run-level completion gate; the single call that reaches the expected
    //    count emits simulation_completed (SETNX inside the Lua makes this exactly-once). ──
    const { processed, completedByThisCall } = await incrementAndCheckCompletion(redis, simRunUuid);
    if (completedByThisCall) {
      await emitSimulationCompleted(redis, simRunUuid, { scenarios_processed: processed });
    }
  } catch (err) {
    // Panic-recovery equivalent: runScenario + the gate shouldn't throw, but if anything
    // does (e.g. Redis blip on the gate), fail the scenario so the gate still advances and
    // swallow the error so the message is deleted ("always complete").
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sim-consumer] run ${simRunUuid} scenario ${scenarioId}: unexpected error — ${message}`);
    try {
      await failScenario(redis, simRunUuid, scenarioId, `panic: ${message}`);
    } catch (failErr) {
      // Even failScenario failed (Redis fully down). Nothing left to do but log + delete.
      console.error(`[sim-consumer] run ${simRunUuid} scenario ${scenarioId}: failScenario also failed — ${(failErr as Error).message}`);
    }
  }
}

/** Options for the poll loop. */
export interface ConsumeOptions {
  /** SQS queue URL to drain. */
  queueUrl: string;
  /** Max scenarios processed concurrently within a received batch (the fan-out bound). */
  concurrency: number;
  /** Abort to stop the loop cleanly (wired to SIGTERM/SIGINT in the worker). */
  signal: AbortSignal;
  /** Injectable SQS client (tests pass one pointed at ElasticMQ; prod builds one from config). */
  sqs?: SQSClient;
}

/**
 * Process a received batch with a bounded number of in-flight handlers. A fixed pool of
 * `min(concurrency, batch.length)` workers each pulls the next message off a shared cursor,
 * runs the handler, and DELETES the message on handler success. handleSimulationMessage
 * never rethrows (it always means "delete"), so a handler rejection here would be a genuine
 * infra fault (e.g. the delete call) — we log it and leave the message for redelivery rather
 * than deleting work that didn't complete.
 */
async function processBatch(
  deps: ConsumerDeps,
  sqs: SQSClient,
  queueUrl: string,
  messages: Message[],
  concurrency: number,
): Promise<void> {
  let cursor = 0;
  const next = (): Message | undefined => (cursor < messages.length ? messages[cursor++] : undefined);

  const worker = async (): Promise<void> => {
    for (let msg = next(); msg !== undefined; msg = next()) {
      if (!msg.Body || !msg.ReceiptHandle) continue; // SQS guarantees both on a real message
      try {
        await handleSimulationMessage(deps, msg.Body);
        // Handler resolved → "complete" → delete so it isn't redelivered.
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: msg.ReceiptHandle }));
      } catch (err) {
        // handleSimulationMessage never rethrows, so reaching here means the DeleteMessage
        // call failed. Don't delete — let the visibility timeout lapse + SQS redeliver.
        console.error(`[sim-consumer] failed to delete message ${msg.MessageId ?? "<unknown>"}: ${(err as Error).message}`);
      }
    }
  };

  const poolSize = Math.max(1, Math.min(concurrency, messages.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
}

/**
 * The long-poll consumer loop. Receives up to 10 messages with a 20s long poll, processes
 * the batch with bounded concurrency, deletes each completed message, and repeats until the
 * signal aborts. The 20s WaitTimeSeconds also bounds shutdown latency: an in-flight receive
 * returns within ~20s of the abort, then the loop's `signal.aborted` check exits cleanly.
 */
export async function consumeSimulationQueue(deps: ConsumerDeps, opts: ConsumeOptions): Promise<void> {
  const { queueUrl, concurrency, signal } = opts;
  const sqs = opts.sqs ?? new SQSClient({ region: simEngineConfig.awsRegion });

  console.log(`[sim-consumer] started — draining ${queueUrl} (concurrency ${concurrency})`);

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
      console.error(`[sim-consumer] ReceiveMessage failed: ${(err as Error).message}`);
      await Bun.sleep(1000);
      continue;
    }

    if (messages.length === 0) continue; // long poll expired with nothing — loop
    await processBatch(deps, sqs, queueUrl, messages, concurrency);
  }

  console.log("[sim-consumer] stopped");
}
