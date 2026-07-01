// AO Simulation Engine — :RESULTS event layer (typed emitters).
//
// The five simulation events the engine writes to the Redis :RESULTS stream, with payloads
// byte-identical to the worker's (models.go SimEventType + the eventData maps in
// scenario_runner.go / simulation_eval_handler.go). The orchestrator service reads these and persists + relays
// them unchanged. V1 ships without eval, so scenario_completed omits evaluation/eval_error.

import { xaddEvent, type RedisClient } from "../queue/redis.js";
import type { EvaluationResult } from "../../evals-engine/index.js";

export const SIM_EVENT = {
  SCENARIO_STARTED: "scenario_started",
  TURN_COMPLETED: "turn_completed",
  SCENARIO_COMPLETED: "scenario_completed",
  SIMULATION_COMPLETED: "simulation_completed",
  SIMULATION_ERROR: "simulation_error",
} as const;
export type SimEventType = (typeof SIM_EVENT)[keyof typeof SIM_EVENT];

export const SIM_ERROR = {
  INVALID_INPUT: "InvalidInput",
  UPSTREAM_TRANSIENT: "UpstreamTransient",
  UPSTREAM_PERMANENT: "UpstreamPermanent",
  EVAL_LOGIC: "EvalLogic",
} as const;
export type SimErrorType = (typeof SIM_ERROR)[keyof typeof SIM_ERROR];

/** scenario_started — simulation_eval_handler.go:132. */
export interface ScenarioStartedEvent {
  scenario_id: string;
  scenario_index: number;
  scenario_name: string;
  goal: string;
  flow_run_uuid: string;
}

/** turn_completed — scenario_runner.go:438. */
export interface TurnCompletedEvent {
  scenario_id: string;
  turn: number;
  node_uuid: string;
  user: string;
  agent: string;
  /** "speech" | "transition" — whether the agent spoke or silently transitioned (scenario_runner.go:494). */
  turn_type: string;
  /** Whether this turn had a real spoken agent utterance (scenario_runner.go:495). */
  is_spoken: boolean;
  intent: string;
  variables: Record<string, unknown>;
  variables_by_node: Record<string, Record<string, unknown>>;
  tool_calls: unknown[];
  response_items: unknown[];
  is_interruption: boolean;
  is_non_answer: boolean;
  non_answer_type: string;
  partial_assistant_msg: string;
}

/** scenario_completed — simulation_eval_handler.go:227 (success) / :291 (failure).
 *  Node+goal `evaluation` is attached on the success path (cx-sqs SkipConversationEval); on eval failure
 *  `eval_error: true` is set instead (never both). `error` is set on the scenario failure path. */
export interface ScenarioCompletedEvent {
  scenario_id: string;
  flow_run_uuid?: string;
  stop_reason: string;
  turns?: number;
  nodes_visited?: number;
  error?: string;
  /** The node+goal evaluation (cx-sqs `evaluation`). Omitted when eval failed or produced nothing. */
  evaluation?: EvaluationResult;
  /** Set true (instead of `evaluation`) when scoring failed — mirrors cx-sqs `eval_error`. */
  eval_error?: boolean;
}

/** simulation_error — run_manager.go FailSimulationRun:250. */
export interface SimulationErrorEvent {
  error_type: SimErrorType;
  message: string;
  scenario_id?: string;
}

export const emitScenarioStarted = (redis: RedisClient, runUuid: string, p: ScenarioStartedEvent) =>
  xaddEvent(redis, runUuid, SIM_EVENT.SCENARIO_STARTED, p);

export const emitTurnCompleted = (redis: RedisClient, runUuid: string, p: TurnCompletedEvent) =>
  xaddEvent(redis, runUuid, SIM_EVENT.TURN_COMPLETED, p);

export const emitScenarioCompleted = (redis: RedisClient, runUuid: string, p: ScenarioCompletedEvent) =>
  xaddEvent(redis, runUuid, SIM_EVENT.SCENARIO_COMPLETED, p);

/** CompleteSimulationRun (run_manager.go:232): the event_data IS the summary map. */
export const emitSimulationCompleted = (redis: RedisClient, runUuid: string, summary: Record<string, unknown>) =>
  xaddEvent(redis, runUuid, SIM_EVENT.SIMULATION_COMPLETED, summary);

/** FailSimulationRun (run_manager.go:250): {error_type, message, scenario_id?}. */
export function emitSimulationError(
  redis: RedisClient,
  runUuid: string,
  errorType: SimErrorType,
  message: string,
  scenarioId?: string,
): Promise<string | null> {
  const p: SimulationErrorEvent = { error_type: errorType, message };
  if (scenarioId) p.scenario_id = scenarioId;
  return xaddEvent(redis, runUuid, SIM_EVENT.SIMULATION_ERROR, p);
}
