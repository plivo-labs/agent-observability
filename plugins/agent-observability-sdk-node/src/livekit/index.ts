/**
 * LiveKit-native helpers for agent-observability (Node).
 *
 * Two helpers, two problems:
 *
 *   - `initObservability` — bootstrap the current session. Resolves the
 *     upload URL (throwing if unset) and emits the tag bundle the
 *     server's ingest path expects.
 *   - `ensureObservabilityUrl` — soft-contract URL resolver that logs
 *     `info` when set and `warn` when not. `initObservability` builds
 *     on it but escalates to a thrown `Error` when missing; use this
 *     directly when you need the non-fatal flavour (tests, local-only
 *     workers, opt-in observability).
 *
 * For the vitest reporter, import from `agent-observability-sdk/livekit/vitest`.
 * Judges are not exposed here — LiveKit Node Agents 1.3.0 has no Judge
 * API (Python ships a port for the Python-side `JudgeGroup`).
 */

export {
  addGoalTags,
  initObservability,
  type Tagger,
  type InitObservabilityOptions,
  type Goal,
} from "./tags.js";
export {
  ensureObservabilityUrl,
  resolveObservabilityUrl,
  type EnsureObservabilityUrlOptions,
} from "./env.js";
