// AO Simulation Engine — SSE event names + envelope (Phase 4.1, AD-5).
//
// The names are EXACTLY the set the console's simulation-store consumes, so the eventual console
// cutover is near-zero change. Every payload is wrapped in the same envelope the worker uses —
// {<id>, event_version, event_data} — so a consumer reads `event_data.<field>` uniformly across
// AO-emitted events (started/progress/scenario_saved/completed) and relayed worker events
// (scenario_started/turn_completed/…). The run SSE relay forwards worker entries verbatim.

/** The full event-name set AO emits (== console simulation-store.ts). */
export const SSE = {
  STARTED: "started",
  SIMULATION_STARTED: "simulation_started",
  SCENARIO_GENERATED: "scenario_generated",
  SCENARIO_SAVED: "scenario_saved",
  PROGRESS: "progress",
  COMPLETED: "completed",
  ERROR: "error",
  SCENARIO_DB_READY: "scenario_db_ready",
  SCENARIO_STARTED: "scenario_started",
  TURN_COMPLETED: "turn_completed",
  SCENARIO_COMPLETED: "scenario_completed",
  SIMULATION_COMPLETED: "simulation_completed",
  SIMULATION_CANCELLED: "simulation_cancelled",
  SIMULATION_ERROR: "simulation_error",
  STREAM_ENDED: "stream_ended",
} as const;

/** Terminal events that end a run's SSE relay (mirrors the worker/aiassist set). */
export const TERMINAL_SSE = new Set<string>([
  SSE.SIMULATION_COMPLETED,
  SSE.SIMULATION_ERROR,
  SSE.SIMULATION_CANCELLED,
]);

/** Build the JSON `data:` payload for an AO-emitted event: the standard
 *  {<idField>, event_version, event_data} envelope, serialized. */
export function envelope(idField: "run_uuid" | "generation_id", idValue: string, eventData: unknown): string {
  return JSON.stringify({ [idField]: idValue, event_version: 1, event_data: eventData });
}
