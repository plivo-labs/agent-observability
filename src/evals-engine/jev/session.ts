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
  runCustomMetricJudge,
  type CustomJudgeSpec,
  type CustomMetricVerdict,
} from "../judges/custom-metric.js";
import { deriveInstructionAdherence, mapHallucination, mapNodeLoop, mapVariableExtraction } from "../aggregate.js";
import { AUTO_FAIL_JUDGES, AUTO_PASS_JUDGES, decisionProvenance, isPublished, parseJudgeList, routeAxis, type RoutePolicy } from "./policy.js";
import { DEFAULT_BUDGET_TOKENS, VOICE_ONLY, buildJevPlan, parseJevJudges, type ConversationJudgeName, type NodeJudgeName } from "./plan.js";
import { buildSharedJevPlan } from "./plan-shared.js";
import { byAxisId, gatePlan, mergeChunkedAxes, type GatedAxis, type RequestResult } from "./gate.js";
import { attachDetectionProvenance, jevAdherence, jevDetection, jevHallucination, jevIntent, jevNodeLoop, jevVariables, type ReasonMap } from "./merge.js";
import { writeDecisionReasons, type ReasonRequestAxis } from "../judges/reason-writer.js";
import { classifyErrorDurability } from "../../error-durability.js";

// Jev answers every gated question first. A confident outcome on a judge the
// route policy names is published as Jev's verdict, and one batched LLM call
// writes its reasoning; everything uncertain, every confident outcome not
// named, and every custom metric gets the full independent LLM judge.

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
    layout: "views" | "shared";
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

/** What fired on a defect, in the judge's own terms, so the writer can point
 *  at it: the variable names for extraction, the question names otherwise. */
function firedDetail(g: GatedAxis): string | undefined {
  if (g.axis.kind !== "node" && g.axis.kind !== "conversation") return undefined;
  const fired = new Set(g.firedKeys);
  if (g.axis.kind === "node" && g.axis.variables) {
    const names = g.axis.variables.filter((v) => fired.has(v.key)).map((v) => v.variable);
    return names.length ? `variables: ${names.join(", ")}` : undefined;
  }
  const names = g.firedKeys.map((k) => { const parts = k.split("."); const last = parts.at(-1)!; return /^\d+$/.test(last) ? `${parts.at(-2)} ${last}` : last; });
  return names.length ? `flagged: ${names.join(", ")}` : undefined;
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
  const autoPass = parseJudgeList(envConfig.JEV_NODE_AUTO_PASS, AUTO_PASS_JUDGES);
  const autoFail = parseJudgeList(envConfig.JEV_AUTO_FAIL, AUTO_FAIL_JUDGES);
  for (const [name, list] of [["JEV_NODE_AUTO_PASS", autoPass], ["JEV_AUTO_FAIL", autoFail]] as const) {
    if (list.unknown.length > 0) console.warn(`[jev] ${name} names no such judge: ${list.unknown.join(", ")} — those stay on LLM review`);
  }
  const inert = [...autoFail.judges].filter((j) => (gates[j]?.fail_above ?? 2) > 1);
  if (inert.length > 0) console.warn(`[jev] JEV_AUTO_FAIL names judges whose gate never fails: ${inert.join(", ")} — set a fail_above in JEV_GATES or they stay on LLM review`);
  const policy: RoutePolicy = { nodeAutoPass: autoPass.judges, autoFail: autoFail.judges };
  const explainPasses = (envConfig.JEV_DECISION_REASONS ?? "fails") === "all";

  const shared = envConfig.JEV_LAYOUT === "shared";
  const plan = (shared ? buildSharedJevPlan : buildJevPlan)(input, {
    judges,
    customSpecs: customJudges,
    customEnabled,
    budgetTokens: envConfig.JEV_STATE_TOKEN_BUDGET ?? DEFAULT_BUDGET_TOKENS,
  });

  const layout = plan.layout;
  const startedAt = Date.now();
  const results = await runPlanRequests(jev, plan.requests);
  const jevMs = Date.now() - startedAt;
  const gated = byAxisId(mergeChunkedAxes(gatePlan(plan, results, gates, input.nodes)));

  const stats: JevSessionResult["stats"] = {
    requests: plan.requests.length,
    layout: shared ? "shared" : "views",
    axesTotal: gated.size,
    autoPass: 0,
    autoFail: 0,
    unknown: 0,
    reviewed: 0,
    fallbacks: {},
    jevMs,
  };
  for (const g of gated.values()) {
    const route = routeAxis(g, policy);
    if (route === "auto_pass") stats.autoPass++;
    else if (route === "auto_fail") stats.autoFail++;
    else stats.reviewed++;
    if (g.fallback) stats.fallbacks[g.fallback] = (stats.fallbacks[g.fallback] ?? 0) + 1;
  }

  const voice = isVoiceChannel(input.transport);
  const hasTranscript = !!input.full_transcript?.trim();
  const provenanceFor = (id: string): JudgeProvenance => {
    const g = gated.get(id);
    return decisionProvenance(g, g ? gates[g.axis.kind === "custom" ? CUSTOM_METRIC_GATE : g.axis.judge] : undefined, policy, layout);
  };
  const published = (id: string): GatedAxis | undefined => {
    const g = gated.get(id);
    return g && isPublished(routeAxis(g, policy)) ? g : undefined;
  };

  // ── the reasoning for every published verdict, in ONE call ────────────────
  const reasonAxes: ReasonRequestAxis[] = [];
  const reasonNodeIndexes = new Set<number>();
  for (const g of gated.values()) {
    if (!isPublished(routeAxis(g, policy))) continue;
    const kind = g.outcome === "fail" ? "defect" : "clean";
    if (kind === "clean" && !explainPasses) continue;
    const nodeIndex = g.axis.kind === "node" ? g.axis.nodeIndex : undefined;
    if (nodeIndex !== undefined) reasonNodeIndexes.add(nodeIndex);
    const detail = kind === "defect" ? firedDetail(g) : undefined;
    reasonAxes.push({
      id: g.axis.id,
      judge: g.axis.judge,
      kind,
      ...(nodeIndex !== undefined ? { node_name: input.nodes[nodeIndex]?.node_name } : {}),
      ...(detail ? { detail } : {}),
    });
  }
  const reasonsPromise: Promise<ReasonMap> = reasonAxes.length
    ? writeDecisionReasons({
        ctx: input,
        nodes: input.nodes.flatMap((node, nodeIndex) => (reasonNodeIndexes.has(nodeIndex) ? [{ node, nodeIndex }] : [])),
        axes: reasonAxes,
        provider,
      })
        .then((r) => r.reasons)
        .catch((e) => {
          // A transient provider failure retries the whole session, exactly as
          // a judge call does; a deterministic one keeps the verdicts with
          // templated reasons rather than inventing evidence.
          if (classifyErrorDurability(e) === "transient") throw e;
          console.error(`[jev] reason writer unavailable — keeping verdicts with templated reasons: ${(e as Error).message}`);
          return new Map();
        })
    : Promise.resolve(new Map());

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
        const g = published(`c.${judge}`);
        if (g) {
          provenance.set(metricKey, provenanceFor(`c.${judge}`));
          return [rawKey, jevDetection(g, await reasonsPromise)];
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
      const decidedByJev = (judge: NodeJudgeName) => published(`n${nodeIndex}:${judge}`);
      const [adherence, hallucination, variable, loop, intent] = await Promise.all([
        (async () => {
          const g = decidedByJev("instructions_adherence");
          if (g) return { ...jevAdherence(g, await reasonsPromise), ...provenance("instructions_adherence") };
          const { data } = await runInstructionAdherenceJudge(node, input, provider);
          return { ...deriveInstructionAdherence(data), ...provenance("instructions_adherence") };
        })(),
        (async () => {
          const g = decidedByJev("hallucination");
          if (g) return { ...jevHallucination(g, await reasonsPromise), ...provenance("hallucination") };
          const { data } = await runHallucinationJudge(node, input, provider);
          return { ...mapHallucination(data), ...provenance("hallucination") };
        })(),
        (async () => {
          const g = decidedByJev("variable_extraction");
          if (g) return { ...jevVariables(g, node, await reasonsPromise).metrics, ...provenance("variable_extraction") };
          const { data } = await runVariableExtractionJudge(node, input, provider);
          return { ...mapVariableExtraction(data, node.required_variables), ...provenance("variable_extraction") };
        })(),
        (async () => {
          const g = decidedByJev("node_loop");
          if (g) return { ...jevNodeLoop(g, await reasonsPromise), ...provenance("node_loop") };
          const { data } = await runLoopJudge(node, input, provider);
          return { ...mapNodeLoop(data), ...provenance("node_loop") };
        })(),
        (async () => {
          const g = decidedByJev("intent_identification");
          if (g) return { ...jevIntent(g, await reasonsPromise), ...provenance("intent_identification") };
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
      // The shared judge owns roll-up and deterministic/transient failure handling.
      const verdict = await runCustomMetricJudge(spec, input, refOf, provider);
      if (spec.scope === "conversation") return { ...verdict, ...provenanceFor(`m.${spec.name}`) };
      const candidates = input.nodes.map((node, i) => ({ ref: refOf(node.node_uuid), ...provenanceFor(`m${i}.${spec.name}`) }));
      return {
        ...verdict, backend: "llm",
        ...(verdict.per_node ? { per_node: verdict.per_node.map((n, i) => ({ ...n, ...candidates[i] })) } : {}),
        ...(!verdict.available ? { jev_node_candidates: candidates } : {}),
      };
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
