// AO Simulation Engine — :RESULTS event layer (typed emitters).
//
// The five simulation events the engine writes to the Redis :RESULTS stream, with payloads
// byte-identical to the worker's (models.go SimEventType + the eventData maps in
// scenario_runner.go / simulation_eval_handler.go). aiassist reads these and persists + relays
// them unchanged. V1 ships without eval, so scenario_completed omits evaluation/eval_error.

import { xaddEvent, type RedisClient } from "../queue/redis.js";

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
 *  V1 has no eval, so `evaluation`/`eval_error` are omitted; `error` is set on the failure path. */
export interface ScenarioCompletedEvent {
  scenario_id: string;
  flow_run_uuid?: string;
  stop_reason: string;
  turns?: number;
  nodes_visited?: number;
  error?: string;
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
