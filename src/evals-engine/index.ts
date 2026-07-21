// AO Eval Engine — public API.
//
// `evaluateSimulation(input)` scores one simulation scenario (node + goal axes) and returns the
// `EvaluationResult` that becomes the `evaluation` payload on `scenario_completed`. It THROWS on judge
// failure; the run path (integration/sim-adapter.ts) converts a throw into `eval_error: true` so a scoring
// failure never blocks the scenario. Phase 2 will add `evaluateLiveSession` (conversation axis) here.

export { evaluateSimulation, type EvaluateSimulationOpts } from "./evaluator.js";
export { normalizeToolCalls } from "./conversation-input.js";
export type {
  ConversationInput,
  NodeEvalInput,
  GoalInput,
  EvalTurn,
  EvalToolCall,
  NodeGoalEvaluation,
  EvaluationResult,
  NodeEvaluation,
  GoalEvaluation,
  GoalResult,
  SimEvalOutcome,
} from "./types.js";
