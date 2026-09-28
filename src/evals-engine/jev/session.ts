import { config as envConfig } from "../../config.js";
import type { LlmProvider } from "../../llm/index.js";
import type { JevClient, JevResponse } from "../../jev/types.js";
import { CUSTOM_METRIC_GATE, resolveGates } from "../../jev/gates.js";
import type {
  ConversationInput,
  JudgeProvenance,
  NodeEvaluation,
  SimConversationMetrics,
} from "../types.js";
import {
  assembleConversationMetrics,
  isVoiceChannel,
  runDetection,
  runSentiment,
  runStt,
  skippedDetection,
  skippedStt,
  zeroConversationMetrics,
  evaluateHumanTransferMetric,
  BOT,
  CALL_SCREENING,
  DO_NOT_DISTURB,
  LOW_ENGAGEMENT,
  VOICEMAIL,
  WRONG_NUMBER,
  type ConversationDetectionRaws,
  type DetectionResult,
} from "../judges/conversation-judges.js";
import { runHallucinationJudge, runInstructionAdherenceJudge, runLoopJudge } from "../judges/node-judges.js";
import { runVariableExtractionJudge } from "../judges/variable-extraction.js";
import { runIntentJudge } from "../judges/intent-judge.js";
import {
  judgeCustomMetricNode,
  rollUpNodeVerdicts,
  runCustomMetricJudge,
  type CustomJudgeSpec,
  type CustomMetricNodeVerdict,
  type CustomMetricVerdict,
} from "../judges/custom-metric.js";
import { deriveInstructionAdherence, mapHallucination, mapNodeLoop, mapVariableExtraction } from "../aggregate.js";
import { classifyErrorDurability } from "../../error-durability.js";
import { decisionProvenance, routeAxis } from "./policy.js";
import { DEFAULT_BUDGET_TOKENS, VOICE_ONLY, buildJevPlan, parseJevJudges, type ConversationJudgeName, type NodeJudgeName } from "./plan.js";
import { byAxisId, gatePlan, mergeChunkedAxes, type RequestResult } from "./gate.js";
import { attachDetectionProvenance, jevDetection } from "./merge.js";

// Jev supplies a candidate. Only clean, complete results over unchanged
// conversation evidence may skip review. Every suspected failure, custom
// metric and changed node view goes to the existing independent LLM judge.

/** The conversation detections Jev can answer, with everything the three
 *  layers need: the LLM criteria to fall back to, the raw key resolveOutcomes
 *  reads, and the emitted metric the provenance is stamped on. */
const CONVERSATION_AXES: ReadonlyArray<{
  judge: ConversationJudgeName;
  criteria: string;
  rawKey: keyof ConversationDetectionRaws;
  metricKey: keyof SimConversationMetrics;
}> = [
  { judge: "voicemail_detection", criteria: VOICEMAIL, rawKey: "voicemail", metricKey: "voicemail_detected" },
  { judge: "bot_detection", criteria: BOT, rawKey: "bot", metricKey: "bot_detected" },
  { judge: "call_screening", criteria: CALL_SCREENING, rawKey: "screening", metricKey: "call_screening" },
  { judge: "low_engagement", criteria: LOW_ENGAGEMENT, rawKey: "lowEngagement", metricKey: "low_engagement" },
  { judge: "wrong_number", criteria: WRONG_NUMBER, rawKey: "wrongNumber", metricKey: "wrong_number" },
  { judge: "do_not_disturb", criteria: DO_NOT_DISTURB, rawKey: "doNotDisturb", metricKey: "do_not_disturb" },
];

export interface JevSessionResult {
  conversation_metrics: SimConversationMetrics;
  node_evaluations: NodeEvaluation[];
  custom_metrics: CustomMetricVerdict[];
  /** Counters for the one-line session log (and the dev rollout dashboards). */
  stats: {
    requests: number;
    axesTotal: number;
    autoPass: number;
    autoFail: number;
    /** Custom metrics the call never reached — neither a pass nor a fail. */
    unknown: number;
    reviewed: number;
    fallbacks: Record<string, number>;
    jevMs: number;
  };
}

/** Ask Jev everything at once. One request's failure is local to its axes. */
async function runPlanRequests(
  jev: JevClient,
  requests: ReturnType<typeof buildJevPlan>["requests"],
): Promise<Map<string, RequestResult>> {
  const entries = await Promise.all(
    requests.map(async (request): Promise<[string, RequestResult]> => {
      try {
        const response: JevResponse = await jev.systemOne(request);
        return [request.key, { ok: true, response }];
      } catch (error) {
        // The only place a Jev failure is visible: without it a rotated key, a
        // wrong base URL and an outage all look identical in the data (every
        // axis simply says backend=llm).
        console.warn(`[jev] request=${request.key} failed, its axes fall back to the LLM judge: ${(error as Error).message}`);
        return [request.key, { ok: false, error }];
      }
    }),
  );
  return new Map(entries);
}

export async function evaluateSessionJevFirst(args: {
  input: ConversationInput;
  refOf: (nodeUuid: string) => string;
  jev: JevClient;
  provider?: LlmProvider;
  customJudges?: readonly CustomJudgeSpec[];
}): Promise<JevSessionResult> {
  const { input, refOf, jev, provider } = args;
  const customJudges = args.customJudges ?? [];
  const gates = resolveGates(envConfig.JEV_GATES);
  const { judges, unknown } = parseJevJudges(envConfig.JEV_JUDGES);
  if (unknown.length > 0) console.warn(`[jev] JEV_JUDGES names no such judge: ${unknown.join(", ")} — those stay on the LLM path`);
  const customEnabled = (envConfig.JEV_CUSTOM_METRICS ?? "off") === "on";

  const plan = buildJevPlan(input, {
    judges,
    customSpecs: customJudges,
    customEnabled,
    budgetTokens: envConfig.JEV_STATE_TOKEN_BUDGET ?? DEFAULT_BUDGET_TOKENS,
  });

  const startedAt = Date.now();
  const results = await runPlanRequests(jev, plan.requests);
  const jevMs = Date.now() - startedAt;
  const gated = byAxisId(mergeChunkedAxes(gatePlan(plan, results, gates, input.nodes)));

  const stats: JevSessionResult["stats"] = {
    requests: plan.requests.length,
    axesTotal: gated.size,
    autoPass: 0,
    autoFail: 0,
    unknown: 0,
    reviewed: 0,
    fallbacks: {},
    jevMs,
  };
  for (const g of gated.values()) {
    if (routeAxis(g) === "auto_pass") stats.autoPass++;
    else stats.reviewed++;
    if (g.fallback) stats.fallbacks[g.fallback] = (stats.fallbacks[g.fallback] ?? 0) + 1;
  }

  const voice = isVoiceChannel(input.transport);
  const hasTranscript = !!input.full_transcript?.trim();
  const provenanceFor = (id: string): JudgeProvenance => {
    const g = gated.get(id);
    return decisionProvenance(g, g ? gates[g.axis.kind === "custom" ? CUSTOM_METRIC_GATE : g.axis.judge] : undefined);
  };

  // ── conversation axis ──────────────────────────────────────────────────────
  const conversationPromise = (async (): Promise<{ metrics: SimConversationMetrics; provenance: Map<keyof SimConversationMetrics, JudgeProvenance> }> => {
    const provenance = new Map<keyof SimConversationMetrics, JudgeProvenance>();
    if (!hasTranscript) {
      return { metrics: { ...zeroConversationMetrics(), human_transfer: evaluateHumanTransferMetric(input) }, provenance };
    }
    const voiceOnlySkip = skippedDetection("not applicable on non-voice channel");
    // Sentiment and STT stay on the LLM in v1 (sentiment has no ground truth to
    // calibrate a gate against, STT is a count). They ride the SAME Promise.all
    // as the detections rather than being started separately: a detection
    // rejecting first would otherwise leave them without a handler, and an
    // unhandled rejection takes the whole process down.
    const [rawEntries, sentiment, stt] = await Promise.all([
      Promise.all(
      CONVERSATION_AXES.map(async ({ judge, criteria, rawKey, metricKey }): Promise<[keyof ConversationDetectionRaws, DetectionResult]> => {
        if (VOICE_ONLY.has(judge) && !voice) return [rawKey, voiceOnlySkip];
        const g = gated.get(`c.${judge}`);
        if (g && routeAxis(g) === "auto_pass") {
          provenance.set(metricKey, provenanceFor(`c.${judge}`));
          return [rawKey, jevDetection(g, new Map())];
        }
        // Reviewed (or never asked): the LLM detection judge decides it, and
        // the row says so — a mixed run must be readable from the data alone.
        provenance.set(metricKey, provenanceFor(`c.${judge}`));
        return [rawKey, await runDetection(judge, criteria, input, provider)];
      }),
      ),
      runSentiment(input, provider),
      voice ? runStt(input, provider) : Promise.resolve(skippedStt()),
    ]);
    const raws = Object.fromEntries(rawEntries) as unknown as ConversationDetectionRaws;
    return { metrics: assembleConversationMetrics({ ctx: input, raws, sentiment, stt }), provenance };
  })();

  // ── node axes ──────────────────────────────────────────────────────────────
  const nodesPromise = Promise.all(
    input.nodes.map(async (node, nodeIndex): Promise<NodeEvaluation> => {
      const provenance = (judge: NodeJudgeName) => provenanceFor(`n${nodeIndex}:${judge}`);
      const [adherence, hallucination, variable, loop, intent] = await Promise.all([
        (async () => {
          const { data } = await runInstructionAdherenceJudge(node, input, provider);
          return { ...deriveInstructionAdherence(data), ...provenance("instructions_adherence") };
        })(),
        (async () => {
          const { data } = await runHallucinationJudge(node, input, provider);
          return { ...mapHallucination(data), ...provenance("hallucination") };
        })(),
        (async () => {
          const { data } = await runVariableExtractionJudge(node, input, provider);
          return { ...mapVariableExtraction(data, node.required_variables), ...provenance("variable_extraction") };
        })(),
        (async () => {
          const { data } = await runLoopJudge(node, input, provider);
          return { ...mapNodeLoop(data), ...provenance("node_loop") };
        })(),
        (async () => {
          const { data } = await runIntentJudge(node, input, provider);
          return { ...data, ...provenance("intent_identification") };
        })(),
      ]);
      return {
        node_uuid: node.node_uuid,
        node_name: node.node_name,
        turn_count: node.turn_count,
        instructions_adherence: adherence,
        intent_identification: intent,
        variable_extraction: variable,
        hallucination: hallucination,
        node_loop: loop,
      };
    }),
  );

  // ── custom metrics ─────────────────────────────────────────────────────────
  const customPromise = Promise.all(
    customJudges.map(async (spec): Promise<CustomMetricVerdict | null> => {
      if (!hasTranscript) return null;
      // Same containment the LLM path has: one broken custom judge must not
      // blank the session's other judging, while a provider blip still retries it.
      try {
        if (spec.scope === "conversation") {
          const verdict = await runCustomMetricJudge(spec, input, refOf, provider);
          return { ...verdict, ...provenanceFor(`m.${spec.name}`) };
        }
        return await judgeNodeScopeCustomMetric({ spec, input, refOf, provenanceFor, provider });
      } catch (e) {
        if (classifyErrorDurability(e) === "transient") throw e;
        console.error(`[jev] custom judge ${spec.name} unavailable: ${(e as Error).message}`);
        return {
          judge_name: spec.name,
          display_name: spec.display_name,
          scope: spec.scope,
          verdict: "unknown",
          reason: "",
          technical_reason: `custom judge unavailable: ${(e as Error).message}`,
          available: false,
        };
      }
    }),
  );

  const [conversation, node_evaluations, custom] = await Promise.all([conversationPromise, nodesPromise, customPromise]);

  return {
    conversation_metrics: attachDetectionProvenance(conversation.metrics, conversation.provenance),
    node_evaluations,
    custom_metrics: custom.filter((c): c is CustomMetricVerdict => c !== null),
    stats,
  };
}

/** Preserve candidate and final-judge provenance on each emitted node row. */
async function judgeNodeScopeCustomMetric(args: {
  spec: CustomJudgeSpec;
  input: ConversationInput;
  refOf: (nodeUuid: string) => string;
  provenanceFor: (id: string) => JudgeProvenance;
  provider?: LlmProvider;
}): Promise<CustomMetricVerdict> {
  const { spec, input, refOf, provenanceFor, provider } = args;
  const perNode: CustomMetricNodeVerdict[] = await Promise.all(
    input.nodes.map(async (node, nodeIndex) => ({
      ...await judgeCustomMetricNode(spec, node, input, refOf, provider),
      ...provenanceFor(`m${nodeIndex}.${spec.name}`),
    })),
  );
  const rolled = rollUpNodeVerdicts(perNode);
  const deciding = perNode.find(n => n.verdict === rolled);
  return {
    judge_name: spec.name, display_name: spec.display_name, scope: spec.scope,
    verdict: rolled, reason: deciding?.reason ?? "", technical_reason: deciding?.technical_reason ?? "",
    available: true, per_node: perNode, backend: "llm",
  };
}
