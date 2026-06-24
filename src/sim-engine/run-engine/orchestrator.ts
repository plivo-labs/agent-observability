// AO Simulation Engine — turn-loop orchestrator (the ScenarioRunner).
//
// Faithful port of cx-sqs-worker `usecases/simulation_eval/scenario_runner.go` (the
// `ScenarioRunner` + `ExecuteAINode`), wiring together the pieces built in Stages 2–5:
//   UserSimulator (LLM) → stress injection → /turn client → sm:{} history → :RESULTS emitters,
// driven by the FlowOrchestrator (Stage 4) which calls back into `executeAINode` per ai_agent_v2 node.
//
// `runScenario` owns the per-scenario emit envelope: scenario_started → turn_completed* →
// scenario_completed. The run-level Lua gate + simulation_completed live in the SQS handler (Stage 7).
//
// V1 simplifications vs the Go worker (both deferred, neither touches the :RESULTS stream):
//   - SaveLiveKitContext / SaveTranscriptTurn (Redis) are skipped — they back crash-resume + the
//     inline evaluator, both deferred to V2. State is threaded in-memory across the turn loop.
//   - On SQS redelivery a scenario re-runs from scratch (fresh flow_run_uuid), exactly like the
//     worker (which also mints a fresh flow_run_uuid per message).

import type { z } from "zod";
import type { RedisClient } from "../queue/redis.js";
import type { LlmProvider } from "../../llm/index.js";
import { Scenario as ScenarioSchema, type WorldStateEntry as SchemaWorldStateEntry } from "../schema.js";
import { FlowOrchestrator, parseFlowGraph } from "./flow-executor.js";
import type {
  AINodeExecutor,
  FlowNode,
  NodeExecutionResult,
  OrchestratorResult,
  VariableStore,
  WorldStateEntry,
} from "./flow-types.js";
import { buildAgentConfig } from "./agent-config.js";
import { buildHandoffGraph, computeHandoffPlan, type HandoffGraph } from "./handoff-planner.js";
import { generateUserMessage, type ConversationTurn } from "./user-simulator.js";
import {
  interruptionRatio,
  pickNonAnswerType,
  shouldInjectNonAnswer,
  shouldInterrupt,
  truncateMidSpeech,
  type Rng,
} from "./stress.js";
import { patchAssistantResponse, setSessionTTL, writeAssistantTurn, writeUserTurn } from "./history.js";
import { LiveKitSimClient, makeLiveKitSimClient, type LiveKitSimRequest } from "./livekit-client.js";
import { emitScenarioStarted, emitTurnCompleted, emitScenarioCompleted } from "./stream.js";
import { simEngineConfig } from "../config.js";

type Scenario = z.infer<typeof ScenarioSchema>;

const SESSION_TTL_S = 3600; // matches the worker's HistoryWriter TTL

/** Dependencies the runner needs; all injectable so the turn loop is testable without prod wiring. */
export interface ScenarioRunnerDeps {
  /** Redis client for the sm:{} conversation history the livekit /turn reads AND the :RESULTS emitters. */
  redis: RedisClient;
  /** /turn client (defaults to one built from config). */
  livekit?: LiveKitSimClient;
  /** Stress RNG (defaults to Math.random). */
  rng?: Rng;
  /** LLM provider for the UserSimulator (inject a MockLLM in tests; prod resolves from env). */
  llmProvider?: LlmProvider;
  /** UserSimulator model override (defaults to USER_SIMULATOR_MODEL via config). */
  llmModel?: string;
}

/** One scenario to run — the inline scenario dict + the per-run identifiers (from the SQS message). */
export interface RunScenarioJob {
  simRunUuid: string;
  scenarioId: string;
  scenarioIndex: number;
  scenario: Scenario;
  authId: string;
  agentFlowDescription: string;
  /** Raw flow JSON (the FLOW_JSON aiassist seeded; the engine reads it via getFlowJson). */
  flowJson: string;
  maxTurns: number;
}

/** schema.ts world_state (snake_case `action_mocks`) → the executor's Map (camelCase `actionMocks`). */
function toWorldStateMap(worldState: Record<string, SchemaWorldStateEntry> | undefined): Map<string, WorldStateEntry> {
  const map = new Map<string, WorldStateEntry>();
  if (!worldState) return map;
  for (const [k, v] of Object.entries(worldState)) {
    map.set(k, { outcome: v.outcome, data: v.data ?? null, actionMocks: v.action_mocks ?? null });
  }
  return map;
}

/** Deep copy via JSON round-trip — matches the Go `deepCopyVariablesByNode` (json.Marshal/Unmarshal). */
function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null)) as T;
}

/**
 * One instance per scenario. Implements AINodeExecutor: the FlowOrchestrator calls `executeAINode`
 * each time it reaches an ai_agent_v2 node, and uses the returned `outcome` (the detected intent)
 * to resolve the next edge.
 */
class ScenarioRunner implements AINodeExecutor {
  private readonly redis: RedisClient;
  private readonly livekit: LiveKitSimClient;
  private readonly rng: Rng;
  private readonly llmProvider?: LlmProvider;
  private readonly llmModel?: string;

  private readonly handoffGraph: HandoffGraph;
  private readonly worldStateMap: Map<string, WorldStateEntry>;

  // Mutable per-scenario state, threaded across turns (mirrors the Go ScenarioRunner fields).
  private conversationHistory: ConversationTurn[] = [];
  private sessionTtlSet = false;
  private currentNodeId = "";
  private currentNodeRunUuid = "";
  private contextItems: unknown[] = [];
  private variablesByNode: Record<string, Record<string, unknown>> = {};
  private lastTurnWasInterruption = false;
  private lastTurnWasNonAnswer = false;

  constructor(
    deps: ScenarioRunnerDeps,
    private readonly job: RunScenarioJob,
    private readonly flowConfig: Record<string, unknown>,
    handoffGraph: HandoffGraph,
    private readonly flowRunUuid: string,
    private readonly isOutboundCall: boolean,
  ) {
    this.redis = deps.redis;
    this.livekit = deps.livekit ?? makeLiveKitSimClient();
    this.rng = deps.rng ?? Math.random;
    this.llmProvider = deps.llmProvider;
    this.llmModel = deps.llmModel ?? simEngineConfig.userSimulatorModel;
    this.handoffGraph = handoffGraph;
    this.worldStateMap = toWorldStateMap(job.scenario.world_state as Record<string, SchemaWorldStateEntry>);
  }

  /** Action mocks for a node, by node id then config name (port of resolveActionMocks). */
  private resolveActionMocks(node: FlowNode): Record<string, unknown> | undefined {
    const byId = this.worldStateMap.get(node.id);
    if (byId?.actionMocks) return byId.actionMocks;
    const byName = this.worldStateMap.get(node.configName);
    if (byName?.actionMocks) return byName.actionMocks;
    return undefined;
  }

  async executeAINode(
    node: FlowNode,
    turnIndex: number,
    variableStore: VariableStore,
  ): Promise<NodeExecutionResult | null> {
    // 1. Determine the user message + interruption/non-answer state (mutually exclusive).
    const isNodeSwitch = this.conversationHistory.length > 0 && node.id !== this.currentNodeId;

    let userMsg = "";
    let isInterruption = false;
    let isNonAnswer = false;
    let nonAnswerType = "";
    let partialAssistantMsg = "";

    if (this.conversationHistory.length === 0) {
      userMsg = "Hello!";
    } else if (isNodeSwitch) {
      userMsg = "";
    } else {
      // Non-answer is checked FIRST; interruption only if not a non-answer (matches the Go).
      isNonAnswer = shouldInjectNonAnswer(
        {
          config: this.job.scenario.non_answer,
          conversationHistory: this.conversationHistory,
          isNodeSwitch,
          turnIndex,
          lastTurnWasNonAnswer: this.lastTurnWasNonAnswer,
          lastTurnWasInterruption: this.lastTurnWasInterruption,
        },
        this.rng,
      );
      if (isNonAnswer) {
        nonAnswerType = pickNonAnswerType(this.rng);
      } else if (
        shouldInterrupt(
          {
            config: this.job.scenario.interruption,
            conversationHistory: this.conversationHistory,
            isNodeSwitch,
            turnIndex,
            lastTurnWasInterruption: this.lastTurnWasInterruption,
          },
          this.rng,
        )
      ) {
        isInterruption = true;
        const lastAssistantMsg = this.conversationHistory[this.conversationHistory.length - 1]!.content;
        partialAssistantMsg = truncateMidSpeech(lastAssistantMsg, interruptionRatio(this.rng), this.rng);
      }

      // On interruption the simulator only sees the partial (what the caller "heard").
      let simHistory = this.conversationHistory;
      if (isInterruption) {
        simHistory = this.conversationHistory.slice();
        simHistory[simHistory.length - 1] = { role: "assistant", content: partialAssistantMsg };
      }

      userMsg = await generateUserMessage({
        scenario: this.job.scenario,
        history: simHistory,
        agentFlowDescription: this.job.agentFlowDescription,
        isOutboundCall: this.isOutboundCall,
        partialAssistantMsg,
        nonAnswerType,
        provider: this.llmProvider,
        model: this.llmModel,
      });
    }

    this.lastTurnWasNonAnswer = isNonAnswer;
    this.lastTurnWasInterruption = isInterruption;

    // 2. Pre-write the user turn (skipped on a node switch — livekit's transfer path ignores it;
    //    the assistant reply is written as a standalone turn after the response).
    let convIndex = -1;
    if (!isNodeSwitch) {
      convIndex = await writeUserTurn(this.redis, this.flowRunUuid, node.id, userMsg);
      if (!this.sessionTtlSet) {
        await setSessionTTL(this.redis, this.flowRunUuid, SESSION_TTL_S);
        this.sessionTtlSet = true;
      }
    }

    // 3. Stable nodeRunUuid: rotate only when the node changes.
    if (node.id !== this.currentNodeId) {
      this.currentNodeRunUuid = crypto.randomUUID();
      this.currentNodeId = node.id;
    }
    const nodeRunUuid = this.currentNodeRunUuid;

    // 4. agent_config + the handoff plan livekit uses to route tool-based handoffs.
    // FlowNode → AgentConfigNode: buildAgentConfig only reads `config`; coerce its nullable field.
    const agentConfig = buildAgentConfig(
      { id: node.id, type: node.type, configName: node.configName, config: node.config ?? {} },
      variableStore,
      this.flowConfig,
    );
    const handoffNode = this.handoffGraph.nodes.get(node.id) ?? null;
    agentConfig["output_state_config"] = computeHandoffPlan(
      handoffNode,
      this.handoffGraph,
      this.job.scenario.world_state as Record<string, SchemaWorldStateEntry>,
      variableStore,
    );

    // 5. Call /turn with the full stateless context.
    const req: LiveKitSimRequest = {
      phlo_run_uuid: this.flowRunUuid,
      node_uuid: node.id,
      node_run_uuid: nodeRunUuid,
      auth_id: this.job.authId,
      user_message: userMsg,
      is_interruption: isInterruption,
      agent_config: agentConfig,
      action_mocks: this.resolveActionMocks(node),
      context_items: this.contextItems,
      variables_by_node: this.variablesByNode,
    };
    if (isInterruption) {
      req.partial_assistant_message = partialAssistantMsg;
    }
    const resp = await this.livekit.executeTurn(req);

    // 6. Thread the returned state forward (in-memory; SaveLiveKitContext skipped in V1).
    this.contextItems = resp.context_items ?? [];
    if (resp.variables_by_node != null) {
      this.variablesByNode = resp.variables_by_node;
    }

    const intent = resp.intent;
    const agentMessage = resp.message;
    const variables = resp.variables ?? {};

    // 7. Write the assistant reply: standalone turn on a node switch, else patch the user turn.
    if (isNodeSwitch) {
      await writeAssistantTurn(this.redis, this.flowRunUuid, node.id, intent, variables, agentMessage);
    } else {
      await patchAssistantResponse(this.redis, this.flowRunUuid, convIndex, node.id, intent, variables, agentMessage);
    }

    const variablesByNodeSnapshot = deepCopy(this.variablesByNode);

    // 8. Emit turn_completed (byte-identical payload to scenario_runner.go:438).
    await emitTurnCompleted(this.redis, this.job.simRunUuid, {
      scenario_id: this.job.scenarioId,
      turn: turnIndex,
      node_uuid: node.id,
      user: userMsg,
      agent: agentMessage,
      intent,
      variables,
      variables_by_node: variablesByNodeSnapshot,
      tool_calls: resp.tool_calls ?? [],
      response_items: resp.response_items ?? [],
      is_interruption: isInterruption,
      is_non_answer: isNonAnswer,
      non_answer_type: nonAnswerType,
      partial_assistant_msg: partialAssistantMsg,
    });

    // 9. (SaveTranscriptTurn skipped — V1 has no inline evaluator.)

    // 10. Accumulate conversation history for the simulator (node switch → assistant only).
    if (isNodeSwitch) {
      this.conversationHistory.push({ role: "assistant", content: agentMessage });
    } else {
      this.conversationHistory.push({ role: "user", content: userMsg }, { role: "assistant", content: agentMessage });
    }

    // 11. Return the result for edge resolution (intent → sourceHandle).
    return { outcome: intent, variables, message: agentMessage };
  }
}

/**
 * Run one scenario end-to-end: emit scenario_started, drive the FlowOrchestrator (which calls the
 * ScenarioRunner per ai_agent_v2 node), then emit scenario_completed. Returns the OrchestratorResult
 * so the SQS handler (Stage 7) can advance the Lua completion gate. Never throws — a failure is
 * surfaced as a scenario_completed(error) event + an error-shaped result.
 */
export async function runScenario(deps: ScenarioRunnerDeps, job: RunScenarioJob): Promise<OrchestratorResult> {
  const flowRunUuid = crypto.randomUUID();

  await emitScenarioStarted(deps.redis, job.simRunUuid, {
    scenario_id: job.scenarioId,
    scenario_index: job.scenarioIndex,
    scenario_name: job.scenario.name,
    goal: job.scenario.goal,
    flow_run_uuid: flowRunUuid,
  });

  try {
    // Parse the flow ONCE, then hand the object to both parseFlowGraph and buildHandoffGraph
    // (parseFlowGraph now accepts an already-parsed object). The try wrapper keeps the exact
    // "invalid flow JSON:" error prefix parseFlowGraph used, so the emitted error text is unchanged.
    let flowObj: Record<string, unknown>;
    try {
      flowObj = JSON.parse(job.flowJson) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`invalid flow JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const graph = parseFlowGraph(flowObj);
    const handoffGraph = buildHandoffGraph(flowObj);
    const worldState = toWorldStateMap(job.scenario.world_state as Record<string, SchemaWorldStateEntry>);
    // Outbound when the flow has an initiate_call node (worker simulation_eval_handler.go:163).
    const isOutboundCall = Array.from(graph.nodes.values()).some((n) => n.type === "initiate_call");

    const runner = new ScenarioRunner(deps, job, flowObj, handoffGraph, flowRunUuid, isOutboundCall);
    const orchestrator = new FlowOrchestrator(graph, worldState, job.maxTurns, runner);
    orchestrator.seedStartNodeParams((job.scenario.start_node_params ?? {}) as Record<string, unknown>);

    const result = await orchestrator.run();

    await emitScenarioCompleted(deps.redis, job.simRunUuid, {
      scenario_id: job.scenarioId,
      flow_run_uuid: flowRunUuid,
      stop_reason: result.stop_reason || "end_conversation",
      turns: result.turn_count,
      nodes_visited: result.nodes_visited.length,
    });

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emitScenarioCompleted(deps.redis, job.simRunUuid, {
      scenario_id: job.scenarioId,
      flow_run_uuid: flowRunUuid,
      stop_reason: "error",
      error: message,
    });
    return {
      stop_reason: "error",
      nodes_visited: [],
      last_node_id: "",
      last_node_type: "",
      turn_count: 0,
      error_detail: message,
    };
  }
}
