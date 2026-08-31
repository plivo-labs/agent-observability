// AO Simulation Engine — turn-loop orchestrator (the ScenarioRunner).
//
// agent-runner owns the run: the flow walk (entry resolution, edge resolution, branch evaluation,
// mocked-node execution), node identity, span switching, turn counting and all conversation state.
// AO holds one run per scenario (keyed by phlo_run_uuid) and keeps the OUTER loop — the
// user-simulator (+ stress) and the transcript/eval/DB bookkeeping.
//
// Per turn agent-runner returns the speaker (`turn_node_uuid`, the transcript/judge key), the
// transitions it took (for nodes_visited), `next_speaker` (whether AO sends a caller line or an
// empty greeting next), and — once the flow terminates — `ended` + `stop_reason` + `stop_detail`.
// AO threads none of the walk state back; it only reads response fields.

import type { z } from "zod";
import type { RedisClient } from "../queue/redis.js";
import type { LlmProvider, WireReasoningEffort } from "../../llm/index.js";
import { Scenario as ScenarioSchema } from "../schema.js";
import {
  LiveKitSimClient,
  LiveKitSimError,
  makeLiveKitSimClient,
  ABORT_STOP_REASONS,
  type SimTurnRequest,
  type SimResponse,
} from "./livekit-client.js";
import { generateUserMessage, type ConversationTurn, type UserSimDecision } from "./user-simulator.js";
import {
  interruptionRatio,
  pickNonAnswerType,
  shouldInjectNonAnswer,
  shouldInterrupt,
  truncateMidSpeech,
  type Rng,
} from "./stress.js";
import { emitScenarioStarted, emitScenarioDbReady, emitTurnCompleted, emitScenarioCompleted } from "./stream.js";
import { simEngineConfig } from "../config.js";
import { insertRunScenario, completeRunScenario } from "../db.js";
import { evaluateSimulationForRun } from "../../evals-engine/integration/sim-adapter.js";
import { flowHasOutboundCall } from "../gen/inventory.js";
import type { EvalTurn } from "../../evals-engine/index.js";

type Scenario = z.infer<typeof ScenarioSchema>;

/** Dependencies the runner needs; all injectable so the turn loop is testable without prod wiring. */
export interface ScenarioRunnerDeps {
  /** Redis client for the :RESULTS emitters. */
  redis: RedisClient;
  /** agent-runner sim client (defaults to one built from config). */
  livekit?: LiveKitSimClient;
  /** Stress RNG (defaults to Math.random). */
  rng?: Rng;
  /** LLM provider for the UserSimulator (inject a MockLLM in tests; prod resolves from env). */
  llmProvider?: LlmProvider;
  /** UserSimulator model override (defaults to USER_SIMULATOR_MODEL via config). */
  llmModel?: string;
  /** UserSimulator reasoning-effort override; `undefined` omits the parameter. */
  llmReasoningEffort?: WireReasoningEffort;
}

/** Durable-persistence context: null/absent = do not write ao_sim_* rows for this scenario. */
export interface DbPersistContext {
  tenantId: string;
  agentId: string;
}

/** One scenario to run — the inline scenario dict + the per-run identifiers (from the SQS message). */
export interface RunScenarioJob {
  simRunUuid: string;
  scenarioId: string;
  scenarioIndex: number;
  scenario: Scenario;
  authId: string;
  agentFlowDescription: string;
  /** Raw flow JSON (the FLOW_JSON the orchestrator service seeded), canonical Shape B. */
  flowJson: string;
  maxTurns: number;
  /** When set, runScenario mirrors each Redis emit with an ao_sim_run_scenario write. */
  dbPersist?: DbPersistContext | null;
  /** Durable scenario reference for the DB row (`scenario_ref`). */
  scenarioRef?: string | null;
}

/** Deep copy via JSON round-trip (variablesByNode snapshots for the transcript). */
function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null)) as T;
}

/** Stop reasons that mean the run finished a real conversation (not a walker abort). Only these
 *  may be overridden by a failed route assertion — a walker abort is never masked as route_mismatch. */
const ROUTE_ASSERTABLE_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_conversation",
  "max_turns",
  "caller_goal_met",
  "caller_hung_up",
]);

interface ExpectedRoute {
  source: string;
  intent: string;
  target: string;
}

/** Read `eval_metadata.expected_route_outcome` off the passthrough scenario. Returns null unless
 *  all three ids are present (route assertion is skipped when any is empty). */
function readExpectedRoute(scenario: Scenario): ExpectedRoute | null {
  const em = (scenario as Record<string, unknown>).eval_metadata;
  if (!em || typeof em !== "object") return null;
  const ero = (em as Record<string, unknown>).expected_route_outcome;
  if (!ero || typeof ero !== "object") return null;
  const o = ero as Record<string, unknown>;
  const source = typeof o.source_node_id === "string" ? o.source_node_id : "";
  const intent = typeof o.expected_intent_name === "string" ? o.expected_intent_name : "";
  const target = typeof o.target_node_id === "string" ? o.target_node_id : "";
  if (!source || !intent || !target) return null;
  return { source, intent, target };
}

/** Read `eval_metadata.simulation_mode` off the passthrough scenario (gates goal-judge leniency:
 *  smoke/missing → lenient, stress → strict). */
function readSimulationMode(scenario: Scenario): string | undefined {
  const em = (scenario as Record<string, unknown>).eval_metadata;
  if (!em || typeof em !== "object") return undefined;
  const mode = (em as Record<string, unknown>).simulation_mode;
  return typeof mode === "string" ? mode : undefined;
}

/** Slim per-node view AO keeps from the flow JSON: node type + the judge index fields. Node
 *  config lives under `data.config`, meta name under `data.meta`. */
interface NodeInfo {
  type: string;
  config: Record<string, unknown> | null;
  configName: string;
  metaName: string;
}

function buildNodeIndex(flowObj: Record<string, unknown>): Map<string, NodeInfo> {
  const index = new Map<string, NodeInfo>();
  const nodes = Array.isArray(flowObj.nodes) ? (flowObj.nodes as Record<string, unknown>[]) : [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const id = typeof node.id === "string" ? node.id : "";
    if (!id) continue;
    const data = (node.data && typeof node.data === "object" ? node.data : {}) as Record<string, unknown>;
    const config = (data.config && typeof data.config === "object" ? data.config : null) as Record<string, unknown> | null;
    const meta = (data.meta && typeof data.meta === "object" ? data.meta : {}) as Record<string, unknown>;
    index.set(id, {
      type: typeof node.type === "string" ? node.type : "",
      config,
      configName: typeof config?.name === "string" ? (config.name as string) : "",
      metaName: typeof meta.name === "string" ? (meta.name as string) : "",
    });
  }
  return index;
}

/** Result of one scenario run, consumed by runScenario for the terminal emit + DB row. */
interface RunResult {
  stopReason: string;
  stopDetail: string;
  turnCount: number;
  nodesVisited: number;
  transcript: unknown[];
  evalTurns: EvalTurn[];
  variablesByNode: Record<string, Record<string, unknown>>;
}

/** Stress state stamped onto the transcript turn the caller message drives. */
interface StressState {
  isInterruption: boolean;
  isNonAnswer: boolean;
  nonAnswerType: string;
  partialAssistantMsg: string;
}
const NO_STRESS: StressState = { isInterruption: false, isNonAnswer: false, nonAnswerType: "", partialAssistantMsg: "" };

/**
 * One instance per scenario. Drives the user-simulator loop against agent-runner (which owns the
 * run): it keys the transcript on the SPEAKING node, sends an empty caller line whenever
 * agent-runner reports `next_speaker: "agent"`, and stops when agent-runner reports `ended`.
 */
class ScenarioRunner {
  private readonly redis: RedisClient;
  private readonly livekit: LiveKitSimClient;
  private readonly rng: Rng;
  private readonly llmProvider?: LlmProvider;
  private readonly llmModel?: string;
  private readonly llmReasoningEffort?: WireReasoningEffort;

  // Read (never threaded back) from each response: turn_count gates the pre-turn max_turns check
  // and rides into the DB row; variables_by_node feeds the transcript snapshot + the judges.
  private turnCount = 0;
  private variablesByNode: Record<string, Record<string, unknown>> = {};

  // Terminal state, set from the agent-runner response that reports `ended`.
  private ended = false;
  private stopReason = "";
  private stopDetail = "";

  // Outer-loop bookkeeping.
  private conversationHistory: ConversationTurn[] = [];
  private readonly nodesVisited = new Set<string>();
  private readonly transcriptTurns: unknown[] = [];
  private readonly evalTurns: EvalTurn[] = [];
  /** Per-response route trace (speaker + intent + transitions) for the whole-run route assertion.
   *  Collected from every response, not just recorded turns, so a silent transition still counts. */
  private readonly routeObservations: Array<{ speaker: string; intent: string; transitions: SimResponse["transitions"] }> = [];
  /** The caller (not agent-runner) ended the run — triggers a best-effort livekit.end since the
   *  run is still held on the owning replica. */
  private callerEnded = false;
  private turnIndex = 0;
  private lastTurnWasInterruption = false;
  private lastTurnWasNonAnswer = false;
  /** Whether the next call sends an empty caller line so the landed node speaks first. Initially
   *  true: the first call is a greeting (agent-runner resolves entry and the landing node opens);
   *  thereafter it tracks the response's `next_speaker`. */
  private pendingGreeting = true;
  /** The stress applied to the caller message the NEXT recorded turn carries. */
  private stress: StressState = NO_STRESS;
  /** Defensive iteration bound: agent-runner enforces max_turns, but a buggy response that never
   *  sets `ended` (or a greeting loop, which does not count toward turn_count) must not spin. */
  private readonly hardCap: number;

  constructor(
    deps: ScenarioRunnerDeps,
    private readonly job: RunScenarioJob,
    private readonly flowObj: Record<string, unknown>,
    private readonly nodeIndex: Map<string, NodeInfo>,
    private readonly flowRunUuid: string,
    private readonly isOutboundCall: boolean,
  ) {
    this.redis = deps.redis;
    this.livekit = deps.livekit ?? makeLiveKitSimClient();
    this.rng = deps.rng ?? Math.random;
    this.llmProvider = deps.llmProvider;
    this.llmModel = deps.llmModel ?? simEngineConfig.userSimulatorModel;
    this.llmReasoningEffort = deps.llmReasoningEffort ?? simEngineConfig.userSimulatorReasoningEffort;
    this.hardCap = Math.max(50, this.job.maxTurns * 3);
  }

  /** Base request body — the exact SimTurnRequest fields.
   *  `action_mocks` is omitted: agent-runner reads world_state[node].action_mocks itself. */
  private buildReq(overrides: Partial<SimTurnRequest>): SimTurnRequest {
    return {
      phlo_run_uuid: this.flowRunUuid,
      auth_id: this.job.authId,
      flow: this.flowObj,
      world_state: this.job.scenario.world_state as Record<string, unknown>,
      start_node_params: (this.job.scenario.start_node_params ?? {}) as Record<string, unknown>,
      max_turns: this.job.maxTurns,
      ...overrides,
    };
  }

  /** Fold a response's transitions into nodes_visited (from node, mocked via hops, landing). */
  private recordTransitions(transitions: SimResponse["transitions"]): void {
    for (const tr of transitions ?? []) {
      if (tr.from_node_uuid) this.nodesVisited.add(tr.from_node_uuid);
      for (const hop of tr.via ?? []) if (hop.node_uuid) this.nodesVisited.add(hop.node_uuid);
      if (tr.to_node_uuid) this.nodesVisited.add(tr.to_node_uuid);
    }
  }

  private applyStop(resp: SimResponse): void {
    this.ended = true;
    this.stopReason = resp.stop_reason || "end_conversation";
    this.stopDetail = resp.stop_detail || "";
    this.turnCount = resp.turn_count;
  }

  /** Record one turn: transcript (keyed on the SPEAKER, turn_node_uuid), sim history, eval turn.
   *  A truly empty turn (no caller line and no agent line) is a silent transition — skip it. */
  private async recordTurn(resp: SimResponse, userMsg: string): Promise<void> {
    const agentMsg = resp.message ?? "";
    const spoken = agentMsg.trim() !== "";
    if (userMsg === "" && !spoken) {
      this.stress = NO_STRESS;
      return;
    }
    const nodeUuid = resp.turn_node_uuid || resp.node_uuid;

    // Sim history: the caller's line (if any) and the agent's line (if any). A greeting turn
    // has an empty caller line and a spoken opener — the opener still enters history so the
    // caller answers it; a silent transition (returned above) adds nothing.
    if (userMsg !== "") this.conversationHistory.push({ role: "user", content: userMsg });
    if (spoken) this.conversationHistory.push({ role: "assistant", content: agentMsg });

    const turnPayload = {
      scenario_id: this.job.scenarioId,
      turn: this.turnIndex,
      node_uuid: nodeUuid,
      user: userMsg,
      agent: agentMsg,
      turn_type: resp.turn_type || (spoken ? "speech" : "transition"),
      is_spoken: spoken,
      intent: resp.intent ?? "",
      transitions: resp.transitions ?? [],
      variables: resp.variables ?? {},
      variables_by_node: deepCopy(resp.variables_by_node ?? this.variablesByNode),
      tool_calls: resp.tool_calls ?? [],
      response_items: resp.response_items ?? [],
      is_interruption: this.stress.isInterruption,
      is_non_answer: this.stress.isNonAnswer,
      non_answer_type: this.stress.nonAnswerType,
      partial_assistant_msg: this.stress.partialAssistantMsg,
    };
    this.transcriptTurns.push(turnPayload);
    await emitTurnCompleted(this.redis, this.job.simRunUuid, turnPayload);
    this.evalTurns.push({ node_uuid: nodeUuid, user: userMsg, agent: agentMsg, intent: resp.intent ?? "" });
    this.turnIndex += 1;
    this.stress = NO_STRESS;
  }

  /** Generate the simulated caller's next decision (utterance + target_achieved + end_call),
   *  applying non-answer / interruption stress on the simulator's side only. Stashes the stress
   *  state so the resulting turn records it. */
  private async userSimTurn(): Promise<UserSimDecision> {
    let isInterruption = false;
    let isNonAnswer = false;
    let nonAnswerType = "";
    let partialAssistantMsg = "";

    // Non-answer is checked FIRST; interruption only if not a non-answer (mutually exclusive).
    isNonAnswer = shouldInjectNonAnswer(
      {
        config: this.job.scenario.non_answer,
        conversationHistory: this.conversationHistory,
        isNodeSwitch: false,
        turnIndex: this.turnIndex,
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
          isNodeSwitch: false,
          turnIndex: this.turnIndex,
          lastTurnWasInterruption: this.lastTurnWasInterruption,
        },
        this.rng,
      )
    ) {
      isInterruption = true;
      const lastAssistant = this.conversationHistory[this.conversationHistory.length - 1]?.content ?? "";
      partialAssistantMsg = truncateMidSpeech(lastAssistant, interruptionRatio(this.rng), this.rng);
    }

    // On interruption the simulator only sees the partial (what the caller "heard"); the agent's
    // real context is NOT truncated (agent-runner never learns of the barge-in).
    let simHistory = this.conversationHistory;
    if (isInterruption && simHistory.length > 0) {
      simHistory = this.conversationHistory.slice();
      simHistory[simHistory.length - 1] = { role: "assistant", content: partialAssistantMsg };
    }

    const decision = await generateUserMessage({
      scenario: this.job.scenario,
      history: simHistory,
      agentFlowDescription: this.job.agentFlowDescription,
      isOutboundCall: this.isOutboundCall,
      partialAssistantMsg,
      nonAnswerType,
      provider: this.llmProvider,
      model: this.llmModel,
      reasoningEffort: this.llmReasoningEffort,
      correlationId: this.job.scenarioId,
    });

    this.lastTurnWasNonAnswer = isNonAnswer;
    this.lastTurnWasInterruption = isInterruption;
    this.stress = { isInterruption, isNonAnswer, nonAnswerType, partialAssistantMsg };
    return decision;
  }

  /** Whole-run route assertion (no LLM): after the loop, if the scenario declares an
   *  expected_route_outcome, pass iff some observed turn fired the expected intent at the source
   *  node and the walk passed through the target — as the landing (`to_node_uuid`) or as a mocked
   *  hop in `via` (the expected target is the edge's DIRECT target, e.g. an http node the walk
   *  continues through). A failure on an otherwise-normal completion becomes route_mismatch; a
   *  walker abort is never masked. */
  private assertRoute(): void {
    const expected = readExpectedRoute(this.job.scenario);
    if (!expected) return;
    const passed = this.routeObservations.some(
      (o) =>
        o.speaker === expected.source &&
        o.intent === expected.intent &&
        o.transitions.some(
          (t) => t.to_node_uuid === expected.target || (t.via ?? []).some((v) => v.node_uuid === expected.target),
        ),
    );
    if (passed || !ROUTE_ASSERTABLE_STOP_REASONS.has(this.stopReason)) return;
    this.stopReason = "route_mismatch";
    this.stopDetail = `expected ${expected.source}:${expected.intent} → ${expected.target}; took ${this.describeRouteAtSource(expected.source)}`;
  }

  /** Human-readable trace of what the source node actually did, for the route_mismatch detail. */
  private describeRouteAtSource(source: string): string {
    const atSource = this.routeObservations.filter((o) => o.speaker === source);
    if (atSource.length === 0) return "never reached";
    return atSource
      .map((o) => {
        const targets = o.transitions
          .map((t) => [...(t.via ?? []).map((v) => v.node_uuid), t.to_node_uuid ?? "∅"].join("→"))
          .join(",");
        return `${o.intent || "(no intent)"} → ${targets || "(no transition)"}`;
      })
      .join("; ");
  }

  async run(): Promise<RunResult> {
    // Bound on iterations, NOT turnIndex: a silent transition doesn't advance turnIndex, so a
    // stream of empty responses would spin forever if the cap keyed on it.
    let iterations = 0;
    while (!this.ended && iterations++ < this.hardCap) {
      // Stop before spending a user-simulator call that agent-runner would immediately reject:
      // max_turns is enforced by AR from turn_count, so a non-greeting turn at the cap is a
      // wasted LLM call + a trailing empty agent turn.
      if (!this.pendingGreeting && this.turnCount >= this.job.maxTurns) {
        this.ended = true;
        this.stopReason = "max_turns";
        break;
      }
      const decision: UserSimDecision = this.pendingGreeting
        ? { message: "", target_achieved: false, end_call: false }
        : await this.userSimTurn();
      const resp = await this.livekit.turn(this.buildReq({ user_message: decision.message }));
      this.recordTransitions(resp.transitions);
      this.routeObservations.push({
        speaker: resp.turn_node_uuid || resp.node_uuid,
        intent: resp.intent ?? "",
        transitions: resp.transitions ?? [],
      });
      await this.recordTurn(resp, decision.message);
      this.turnCount = resp.turn_count;
      if (resp.variables_by_node != null) this.variablesByNode = resp.variables_by_node;
      if (resp.ended) {
        // agent-runner terminal wins over a same-turn caller decision.
        this.applyStop(resp);
        break;
      }
      if (decision.end_call) {
        // The caller hung up this turn — its closing line was already sent + recorded above.
        this.ended = true;
        this.stopReason = decision.target_achieved ? "caller_goal_met" : "caller_hung_up";
        this.stopDetail = "";
        this.callerEnded = true;
        break;
      }
      // agent-runner tells AO who speaks next: "agent" ⇒ a landed node opens (empty caller line).
      this.pendingGreeting = resp.next_speaker === "agent";
    }

    if (!this.ended) {
      // The hard cap tripped without agent-runner reporting a terminal — treat as max_turns so the
      // row still completes with a sane reason instead of an empty stop_reason.
      this.stopReason = this.stopReason || "max_turns";
    }

    // Whole-run route assertion may override a normal completion with route_mismatch.
    this.assertRoute();
    // The run is still held on agent-runner after a caller-decided end — release it best-effort.
    if (this.callerEnded) await this.livekit.end(this.flowRunUuid);

    return {
      stopReason: this.stopReason,
      stopDetail: this.stopDetail,
      turnCount: this.turnCount,
      nodesVisited: this.nodesVisited.size,
      transcript: this.transcriptTurns,
      evalTurns: this.evalTurns,
      variablesByNode: this.variablesByNode,
    };
  }
}

/**
 * Run one scenario end-to-end: emit scenario_started, drive the user-simulator loop against
 * agent-runner (which owns the run), then emit scenario_completed. Never throws — a failure is
 * surfaced as a scenario_completed(error) event + the error-shaped DB row.
 */
export async function runScenario(deps: ScenarioRunnerDeps, job: RunScenarioJob): Promise<void> {
  const flowRunUuid = crypto.randomUUID();

  const persistSafe = async (label: string, fn: () => Promise<void>): Promise<void> => {
    if (!job.dbPersist) return;
    try {
      await fn();
    } catch (err) {
      console.error(`[sim-db] ${label} failed (run ${job.simRunUuid} scenario ${job.scenarioId}): ${(err as Error).message}`);
    }
  };

  await emitScenarioStarted(deps.redis, job.simRunUuid, {
    scenario_id: job.scenarioId,
    scenario_index: job.scenarioIndex,
    scenario_name: job.scenario.name,
    goal: job.scenario.goal,
    flow_run_uuid: flowRunUuid,
  });
  await persistSafe("insertRunScenario", async () => {
    await insertRunScenario({
      id: flowRunUuid,
      simRunId: job.simRunUuid,
      scenarioRef: job.scenarioRef ?? job.scenarioId,
      scenarioIndex: job.scenarioIndex,
    });
    await emitScenarioDbReady(deps.redis, job.simRunUuid, {
      scenario_id: job.scenarioId,
      scenario_db_uuid: flowRunUuid,
    });
  });

  const client = deps.livekit ?? makeLiveKitSimClient();
  try {
    let flowObj: Record<string, unknown>;
    try {
      flowObj = JSON.parse(job.flowJson) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`invalid flow JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    // AO keeps a slim flow parse on the run path: the node index (judge config lookup) and the
    // outbound-call flag for the user-simulator.
    const nodeIndex = buildNodeIndex(flowObj);
    const isOutboundCall = flowHasOutboundCall(flowObj);

    const runner = new ScenarioRunner({ ...deps, livekit: client }, job, flowObj, nodeIndex, flowRunUuid, isOutboundCall);
    const result = await runner.run();

    // Skip judges on a 0-turn run (entry resolved straight to a terminal/abort — no conversation).
    const evalOutcome =
      result.turnCount === 0
        ? {}
        : await evaluateSimulationForRun({
            turns: result.evalTurns,
            nodeIndex,
            flowObj,
            variablesByNode: result.variablesByNode,
            scenarioId: job.scenarioId,
            flowUuid: [flowObj.flow_uuid, flowObj.uuid].find((v): v is string => typeof v === "string") ?? job.simRunUuid,
            runUuid: flowRunUuid,
            provider: deps.llmProvider,
            acceptanceCriteria: job.scenario.acceptance_criteria,
            criteriaThreshold: job.scenario.criteria_threshold,
            simulationMode: readSimulationMode(job.scenario),
          });

    const stopReason = result.stopReason || "end_conversation";
    await emitScenarioCompleted(deps.redis, job.simRunUuid, {
      scenario_id: job.scenarioId,
      flow_run_uuid: flowRunUuid,
      stop_reason: stopReason,
      stop_detail: result.stopDetail,
      turns: result.turnCount,
      nodes_visited: result.nodesVisited,
      ...(evalOutcome.evaluation ? { evaluation: evalOutcome.evaluation } : {}),
      ...(evalOutcome.eval_error ? { eval_error: true } : {}),
    });
    // stop_detail rides into the `error` column ONLY for abort reasons — end_conversation /
    // max_turns keep error=null so they still count toward passed/failed (extractGoalPassed
    // stops counting a row once error is non-null). status stays "completed": a walker abort is
    // not a runner exception.
    const abortDetail = (ABORT_STOP_REASONS as ReadonlySet<string>).has(stopReason) ? result.stopDetail || stopReason : null;
    await persistSafe("completeRunScenario", () =>
      completeRunScenario({
        id: flowRunUuid,
        simRunId: job.simRunUuid,
        scenarioRef: job.scenarioRef ?? job.scenarioId,
        scenarioIndex: job.scenarioIndex,
        status: "completed",
        stopReason,
        turnCount: result.turnCount,
        evaluation: evalOutcome.evaluation ?? null,
        evalError: evalOutcome.eval_error ?? false,
        error: abortDetail,
        transcript: result.transcript,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const runLost = err instanceof LiveKitSimError && err.runLost;
    // Best-effort early teardown so a mid-run failure doesn't leave the run held on its owner
    // until TTL (a run_lost owner is already gone — end() no-ops on the dead address).
    await client.end(flowRunUuid);
    await emitScenarioCompleted(deps.redis, job.simRunUuid, {
      scenario_id: job.scenarioId,
      flow_run_uuid: flowRunUuid,
      stop_reason: "error",
      error: message,
      ...(runLost ? { stop_detail: "run_lost" } : {}),
    });
    await persistSafe("completeRunScenario(error)", () =>
      completeRunScenario({
        id: flowRunUuid,
        simRunId: job.simRunUuid,
        scenarioRef: job.scenarioRef ?? job.scenarioId,
        scenarioIndex: job.scenarioIndex,
        status: "error",
        stopReason: "error",
        turnCount: 0,
        error: message,
        transcript: [],
      }),
    );
  }
}
