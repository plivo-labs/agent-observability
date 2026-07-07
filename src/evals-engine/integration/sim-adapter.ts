import type { LlmProvider } from "../../llm/index.js";
import type { FlowGraph } from "../../sim-engine/run-engine/flow-types.js";
import { evaluateSimulation } from "../evaluator.js";
import { fromSimTranscript } from "../conversation-input.js";
import type { EvalTurn, EvaluationResult, SimConversationMetrics, SimEvalOutcome } from "../types.js";

/** The all-default conversation_metrics cx-sqs emits for sim (zero-valued ConversationLevelMetrics{}). Cosmetic
 *  raw-JSON parity — no sim consumer reads it; Phase 2 live eval populates the real values. */
function defaultConversationMetrics(): SimConversationMetrics {
  const det = () => ({ detected: false, detected_value: 0, reason: "", technical_reason: "" });
  return {
    answered: false,
    voicemail_detected: det(),
    cx_voicemail_detected: 0,
    cx_call_screening_detected: 0,
    bot_detected: det(),
    call_screening: det(),
    low_engagement: det(),
    wrong_number: det(),
    do_not_disturb: det(),
    user_sentiment: { sentiment: "", reason: "", technical_reason: "" },
    silent_call: false,
    customer_engaged: false,
    conversation_status: { status: "", reason: "", technical_reason: "" },
    is_livekit: false,
    is_agent_runner: false,
    stt: { error_count: 0, recovered_count: 0 },
  };
}

// AO Eval Engine — the run-path adapter (mirrors cx-sqs's EvaluatorAdapter, SkipConversationEval=true).
// Builds the ConversationInput from the accumulated transcript, runs the node+goal evaluator, and NEVER
// throws: a scoring failure becomes `{ eval_error: true }` so the scenario always completes (cx-sqs sets
// eval_error=true on evaluator error, exactly the same). An empty transcript yields `{}` (no eval, no error).

export interface EvaluateSimulationForRunArgs {
  turns: EvalTurn[];
  graph: FlowGraph;
  flowObj: Record<string, unknown>;
  variablesByNode: Record<string, Record<string, unknown>>;
  scenarioId: string;
  /** cx-sqs ConversationEvaluation header (cosmetic raw-JSON parity). flow_name is taken from the built
   *  input (single source of truth), so only the uuids are passed in. */
  flowUuid: string;
  runUuid: string;
  /** LLM provider (same one the simulator uses); prod resolves from env when undefined. */
  provider?: LlmProvider;
}

export async function evaluateSimulationForRun(args: EvaluateSimulationForRunArgs): Promise<SimEvalOutcome> {
  if (args.turns.length === 0) return {};
  try {
    const input = fromSimTranscript({
      turns: args.turns,
      graph: args.graph,
      flowObj: args.flowObj,
      variablesByNode: args.variablesByNode,
    });
    if (input.nodes.length === 0) return {};
    const scored = await evaluateSimulation(input, { provider: args.provider });
    // Assemble in cx-sqs ConversationEvaluation key order: header → conversation_metrics → node → goal.
    const evaluation: EvaluationResult = {
      flow_uuid: args.flowUuid,
      flow_name: input.flow_name,
      run_uuid: args.runUuid,
      conversation_metrics: defaultConversationMetrics(),
      node_evaluations: scored.node_evaluations,
      ...(scored.goal_evaluation ? { goal_evaluation: scored.goal_evaluation } : {}),
    };
    return { evaluation };
  } catch (e) {
    console.error(`[sim-eval] scenario ${args.scenarioId} evaluation failed: ${(e as Error).message}`);
    return { eval_error: true };
  }
}
