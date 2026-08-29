import type { LlmProvider } from "../../llm/index.js";
import { evaluateSimulation } from "../evaluator.js";
import { fromSimTranscript, type NodeConfigIndex } from "../conversation-input.js";
import type { EvalTurn, EvaluationResult, SimEvalOutcome } from "../types.js";
import { zeroConversationMetrics } from "../judges/conversation-judges.js";

export type { NodeConfigIndex };

// AO Eval Engine — the run-path adapter (mirrors cx-sqs's EvaluatorAdapter, SkipConversationEval=true).
// Builds the ConversationInput from the accumulated transcript, runs the node+goal evaluator, and NEVER
// throws: a scoring failure becomes `{ eval_error: true }` so the scenario always completes (cx-sqs sets
// eval_error=true on evaluator error, exactly the same). An empty transcript yields `{}` (no eval, no error).

export interface EvaluateSimulationForRunArgs {
  turns: EvalTurn[];
  nodeIndex: NodeConfigIndex;
  flowObj: Record<string, unknown>;
  variablesByNode: Record<string, Record<string, unknown>>;
  scenarioId: string;
  /** cx-sqs ConversationEvaluation header (cosmetic raw-JSON parity). flow_name is taken from the built
   *  input (single source of truth), so only the uuids are passed in. */
  flowUuid: string;
  runUuid: string;
  /** LLM provider (same one the simulator uses); prod resolves from env when undefined. */
  provider?: LlmProvider;
  /** Scenario acceptance criteria (from `scenario.acceptance_criteria`); the criteria judge runs
   *  only when this is non-empty. */
  acceptanceCriteria?: string[];
  /** Pass threshold for the criteria score (`scenario.criteria_threshold`). */
  criteriaThreshold?: number;
}

export async function evaluateSimulationForRun(args: EvaluateSimulationForRunArgs): Promise<SimEvalOutcome> {
  if (args.turns.length === 0) return {};
  try {
    const input = fromSimTranscript({
      turns: args.turns,
      nodeIndex: args.nodeIndex,
      flowObj: args.flowObj,
      variablesByNode: args.variablesByNode,
    });
    if (input.nodes.length === 0) return {};
    const scored = await evaluateSimulation(input, {
      provider: args.provider,
      acceptanceCriteria: args.acceptanceCriteria,
      criteriaThreshold: args.criteriaThreshold,
    });
    // Assemble in cx-sqs ConversationEvaluation key order: header → conversation_metrics → node →
    // goal → criteria (criteria_evaluation is AO-only, appended last).
    const evaluation: EvaluationResult = {
      flow_uuid: args.flowUuid,
      flow_name: input.flow_name,
      run_uuid: args.runUuid,
      conversation_metrics: zeroConversationMetrics(),
      node_evaluations: scored.node_evaluations,
      ...(scored.goal_evaluation ? { goal_evaluation: scored.goal_evaluation } : {}),
      ...(scored.criteria_evaluation ? { criteria_evaluation: scored.criteria_evaluation } : {}),
    };
    return { evaluation };
  } catch (e) {
    console.error(`[sim-eval] scenario ${args.scenarioId} evaluation failed: ${(e as Error).message}`);
    return { eval_error: true };
  }
}
