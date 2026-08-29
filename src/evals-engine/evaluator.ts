import type { LlmProvider } from "../llm/index.js";
import type { ConversationInput, NodeEvaluation, NodeGoalEvaluation } from "./types.js";
import {
  runHallucinationJudge,
  runLoopJudge,
  runInstructionAdherenceJudge,
} from "./judges/node-judges.js";
import { runVariableExtractionJudge } from "./judges/variable-extraction.js";
import { runIntentJudge } from "./judges/intent-judge.js";
import { runGoalJudge } from "./judges/goal-judge.js";
import { runCriteriaJudge } from "./judges/criteria-judge.js";
import { deriveInstructionAdherence, mapHallucination, mapNodeLoop, mapVariableExtraction } from "./aggregate.js";

// AO Eval Engine — the orchestrator (port of cx-sqs ConversationEvaluator, node + goal axes only =
// SkipConversationEval). Per AI node: the 4 LLM judges run in PARALLEL + the programmatic intent judge;
// results are mapped/derived into one NodeEvaluation. Then the goal judge runs iff goals are configured
// (the cx-sqs gate → otherwise goal_evaluation is omitted, UI "No goals configured").
//
// Failure model = cx-sqs: a judge that still throws after its retries rejects the node (Promise.all), which
// rejects evaluateSimulation; the run path catches that and sets eval_error=true (no partial/null-field
// evaluation is ever emitted — the console contract stays intact).

export interface EvaluateSimulationOpts {
  /** Test injection; prod resolves the provider from env inside completeJSON. */
  provider?: LlmProvider;
  /** Scenario acceptance criteria — when non-empty the criteria judge runs and its verdict is
   *  attached as `criteria_evaluation`. */
  acceptanceCriteria?: string[];
  /** Pass threshold for the criteria score (defaults to 0.7). */
  criteriaThreshold?: number;
}

async function evaluateNode(
  node: ConversationInput["nodes"][number],
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<NodeEvaluation> {
  const [adherence, hallucination, variable, loop, intent] = await Promise.all([
    runInstructionAdherenceJudge(node, ctx, provider),
    runHallucinationJudge(node, ctx, provider),
    runVariableExtractionJudge(node, ctx, provider),
    runLoopJudge(node, ctx, provider),
    runIntentJudge(node, ctx, provider),
  ]);
  return {
    node_uuid: node.node_uuid,
    node_name: node.node_name,
    turn_count: node.turn_count,
    instructions_adherence: deriveInstructionAdherence(adherence.data),
    intent_identification: intent.data,
    variable_extraction: mapVariableExtraction(variable.data, node.required_variables),
    hallucination: mapHallucination(hallucination.data),
    node_loop: mapNodeLoop(loop.data),
  };
}

/** Score one scenario (node + goal axes). Throws on judge failure; the caller converts that to eval_error. */
export async function evaluateSimulation(input: ConversationInput, opts: EvaluateSimulationOpts = {}): Promise<NodeGoalEvaluation> {
  // Nodes evaluated in parallel (each node's judges are already parallel within evaluateNode).
  const node_evaluations = await Promise.all(input.nodes.map((n) => evaluateNode(n, input, opts.provider)));

  const result: NodeGoalEvaluation = { node_evaluations };
  if (input.goals.length > 0) {
    const { data } = await runGoalJudge(input.goals, input, opts.provider, true);
    result.goal_evaluation = data;
  }
  if (opts.acceptanceCriteria && opts.acceptanceCriteria.length > 0) {
    const { data } = await runCriteriaJudge(opts.acceptanceCriteria, input, opts.provider);
    const threshold = opts.criteriaThreshold ?? 0.7;
    result.criteria_evaluation = { threshold, score: data.score, passed: data.score >= threshold, criteria: data.criteria };
  }
  return result;
}
