import type { LlmProvider, LlmUsage } from "../llm/index.js";
import type { ConversationInput, NodeEvaluation, NodeGoalEvaluation } from "./types.js";
import { modelAnswered, settleAxis, type JudgeTally, type SessionNodeEvaluation } from "./judge-error.js";
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
  /** Scenario simulation_mode: "smoke" (or absent) runs the goal judge leniently (today's
   *  behaviour); "stress" runs it strictly. */
  simulationMode?: string;
}

const judged = <R, T>(run: Promise<{ data: R; usage: LlmUsage }>, map: (data: R) => T) =>
  run.then(({ data, usage }) => ({ value: map(data), modelVerdict: modelAnswered(usage) }));

function runNodeJudges(node: ConversationInput["nodes"][number], ctx: ConversationInput, provider?: LlmProvider) {
  return {
    adherence: judged(runInstructionAdherenceJudge(node, ctx, provider), deriveInstructionAdherence),
    hallucination: judged(runHallucinationJudge(node, ctx, provider), mapHallucination),
    variable: judged(runVariableExtractionJudge(node, ctx, provider), (data) => mapVariableExtraction(data, node.required_variables)),
    loop: judged(runLoopJudge(node, ctx, provider), mapNodeLoop),
    intent: judged(runIntentJudge(node, ctx, provider), (data) => data),
  };
}

async function evaluateNode(
  node: ConversationInput["nodes"][number],
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<NodeEvaluation> {
  const j = runNodeJudges(node, ctx, provider);
  const [adherence, hallucination, variable, loop, intent] = await Promise.all([j.adherence, j.hallucination, j.variable, j.loop, j.intent]);
  return {
    node_uuid: node.node_uuid,
    node_name: node.node_name,
    turn_count: node.turn_count,
    instructions_adherence: adherence.value,
    intent_identification: intent.value,
    variable_extraction: variable.value,
    hallucination: hallucination.value,
    node_loop: loop.value,
  };
}

/** The session path's node axes: a judge failing for good costs only its own
 *  axis. The simulation path keeps evaluateSimulation's all-or-nothing contract. */
export function evaluateSessionNodes(input: ConversationInput, provider: LlmProvider | undefined, tally: JudgeTally): Promise<SessionNodeEvaluation[]> {
  return Promise.all(
    input.nodes.map(async (node): Promise<SessionNodeEvaluation> => {
      const j = runNodeJudges(node, input, provider);
      const [adherence, hallucination, variable, loop, intent] = await Promise.all([
        settleAxis(tally, j.adherence),
        settleAxis(tally, j.hallucination),
        settleAxis(tally, j.variable),
        settleAxis(tally, j.loop),
        settleAxis(tally, j.intent),
      ]);
      return {
        node_uuid: node.node_uuid,
        node_name: node.node_name,
        turn_count: node.turn_count,
        instructions_adherence: adherence,
        intent_identification: intent,
        variable_extraction: variable,
        hallucination,
        node_loop: loop,
      };
    }),
  );
}

/** Score one scenario (node + goal axes). Throws on judge failure; the caller converts that to eval_error. */
export async function evaluateSimulation(input: ConversationInput, opts: EvaluateSimulationOpts = {}): Promise<NodeGoalEvaluation> {
  // Nodes evaluated in parallel (each node's judges are already parallel within evaluateNode).
  const node_evaluations = await Promise.all(input.nodes.map((n) => evaluateNode(n, input, opts.provider)));

  const result: NodeGoalEvaluation = { node_evaluations };
  if (input.goals.length > 0) {
    // smoke (or absent mode) → lenient (the SIMULATION CONTEXT rules); stress → strict.
    const isSimulation = opts.simulationMode !== "stress";
    const { data } = await runGoalJudge(input.goals, input, opts.provider, isSimulation);
    result.goal_evaluation = data;
  }
  if (opts.acceptanceCriteria && opts.acceptanceCriteria.length > 0) {
    const { data } = await runCriteriaJudge(opts.acceptanceCriteria, input, opts.provider);
    const threshold = opts.criteriaThreshold ?? 0.7;
    result.criteria_evaluation = { threshold, score: data.score, passed: data.score >= threshold, criteria: data.criteria };
  }
  return result;
}
