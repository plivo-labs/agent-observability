import { config as envConfig } from "../../config.js";
import type { LlmProvider } from "../../llm/index.js";
import type { JevClient, JevResponse } from "../../jev/types.js";
import { resolveGates } from "../../jev/gates.js";
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
import { writeFailReasons, type ReasonRequestAxis } from "../judges/reason-writer.js";
import { DEFAULT_BUDGET_TOKENS, VOICE_ONLY, buildJevPlan, parseJevJudges, type ConversationJudgeName, type NodeJudgeName } from "./plan.js";
import { byAxisId, gatePlan, mergeChunkedAxes, type GatedAxis, type RequestResult } from "./gate.js";
import {
  attachDetectionProvenance,
  provenanceOf,
  jevAdherence,
  jevCustomMetric,
  jevDetection,
  jevHallucination,
  jevIntent,
  jevNodeLoop,
  jevVariables,
  type ReasonMap,
} from "./merge.js";

// Jev-first judging for one session.
//
//   plan -> ONE round trip of purpose-built requests -> gate each axis
//     confident      -> the verdict is Jev's; one batched LLM call writes the
//                       reasons for the fails, passes get templated text
//     uncertain, or
//     anything Jev
//     could not do   -> the judge that owns the axis runs EXACTLY as today
//
// Nothing here decides an axis Jev did not answer, and nothing here writes a
// verdict shape the LLM path could not have written. That is what makes
// JEV_MODE=off a true rollback rather than a different product.

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

const LLM = { backend: "llm" as const };

/** An escalated axis is the only place a Jev probability and an INDEPENDENT LLM
 *  verdict exist for the same judgement, which is exactly the pair a threshold
 *  is tuned from. Keeping it turns every escalation into a calibration sample;
 *  dropping it means the gates can only ever be retuned by paying for a replay.
 *  `backend` stays "llm" — Luna decided it — and the number is what Jev thought. */
const llmProvenance = (gated: Map<string, GatedAxis>, axisId: string): JudgeProvenance => {
  const p = gated.get(axisId)?.p;
  return p === null || p === undefined ? LLM : { ...LLM, confidence: p };
};

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

function detailFor(g: GatedAxis): string | undefined {
  const axis = g.axis;
  if (axis.kind !== "node") return undefined;
  const fired = new Set(g.firedKeys);
  if (axis.judge === "variable_extraction") {
    const names = (axis.variables ?? []).filter((v) => fired.has(v.key)).map((v) => `${v.variable}${v.recorded ? " (recorded)" : " (not recorded)"}`);
    return names.length ? `variables flagged: ${names.join(", ")}` : undefined;
  }
  if (axis.judge === "intent_identification") {
    const named = (axis.intents ?? []).filter((i) => fired.has(i.key) && i.intent).map((i) => i.intent);
    const wrong = (axis.intents ?? []).some((i) => fired.has(i.key) && !i.intent);
    const parts = [named.length ? `intents that should have fired: ${named.join(", ")}` : "", wrong ? "an intent fired without support from the caller" : ""].filter(Boolean);
    return parts.length ? parts.join("; ") : undefined;
  }
  if (axis.judge === "hallucination") {
    const claims = g.firedKeys.filter((k) => k.includes(".claim.")).length;
    return claims ? `${claims} spoken value(s) could not be grounded` : undefined;
  }
  return undefined;
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
  const gated = byAxisId(mergeChunkedAxes(gatePlan(plan, results, gates)));

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
    if (g.outcome === "pass") stats.autoPass++;
    else if (g.outcome === "fail") stats.autoFail++;
    else if (g.outcome === "unknown") stats.unknown++;
    else stats.reviewed++;
    if (g.fallback) stats.fallbacks[g.fallback] = (stats.fallbacks[g.fallback] ?? 0) + 1;
  }

  const voice = isVoiceChannel(input.transport);
  const hasTranscript = !!input.full_transcript?.trim();
  const decided = (id: string): GatedAxis | undefined => {
    const g = gated.get(id);
    return g && g.outcome !== "review" ? g : undefined;
  };

  // ── the reasons for every confident fail and N/A metric, in ONE call ───────
  const failing: ReasonRequestAxis[] = [];
  // Only the nodes a defect was found on: node configs are large, and sending
  // every node of a 30-node session would make this the most expensive call of
  // the run — and risk truncating the very explanations it exists to produce.
  const failingNodeIndexes = new Set<number>();
  // Capped like the Jev question that decided it: a metric body is free text.
  const metricBody = new Map(customJudges.map((s) => [s.name, `metric '${s.display_name}': ${s.body.slice(0, 1200)}`]));
  for (const g of gated.values()) {
    // A custom metric the call never reached needs prose too — the LLM judge it
    // replaces writes one, and N/A is its commonest outcome, so skipping it
    // would strip reasoning from most custom-metric verdicts.
    const naMetric = g.outcome === "unknown" && g.axis.kind === "custom";
    if (g.outcome !== "fail" && !naMetric) continue;
    const axis = g.axis;
    const nodeIndex = axis.kind === "node" || axis.kind === "custom" ? axis.nodeIndex : undefined;
    // An N/A is explained from the metric text and the transcript, so it does
    // not pull its node config in — that is what keeps this call small when
    // most metrics come back not applicable.
    if (nodeIndex !== undefined && !naMetric) failingNodeIndexes.add(nodeIndex);
    const detail = axis.kind === "custom" ? metricBody.get(axis.judge) : detailFor(g);
    failing.push({
      id: axis.id,
      judge: axis.judge,
      kind: naMetric ? "not_applicable" : "defect",
      ...(nodeIndex !== undefined ? { node_name: input.nodes[nodeIndex]?.node_name } : {}),
      ...(detail ? { detail } : {}),
    });
  }
  const reasonsPromise: Promise<ReasonMap> = failing.length
    ? writeFailReasons({
        ctx: input,
        nodes: input.nodes.flatMap((node, nodeIndex) => (failingNodeIndexes.has(nodeIndex) ? [{ node, nodeIndex }] : [])),
        axes: failing,
        provider,
      })
        .then((r) => r.reasons)
        .catch((e) => {
          // A transient provider failure must retry the whole session, exactly
          // as it does for a judge call; a deterministic one keeps the verdicts
          // and falls back to the templated text.
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
        const g = decided(`c.${judge}`);
        if (g) {
          provenance.set(metricKey, provenanceOf(g));
          return [rawKey, jevDetection(g, await reasonsPromise)];
        }
        // Reviewed (or never asked): the LLM detection judge decides it, and
        // the row says so — a mixed run must be readable from the data alone.
        provenance.set(metricKey, llmProvenance(gated, `c.${judge}`));
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
      const g = (judge: NodeJudgeName) => decided(`n${nodeIndex}:${judge}`);
      const [adherence, hallucination, variable, loop, intent] = await Promise.all([
        (async () => {
          const decision = g("instructions_adherence");
          if (decision) return jevAdherence(decision, await reasonsPromise);
          const { data } = await runInstructionAdherenceJudge(node, input, provider);
          return { ...deriveInstructionAdherence(data), ...llmProvenance(gated, `n${nodeIndex}:instructions_adherence`) };
        })(),
        (async () => {
          const decision = g("hallucination");
          if (decision) return jevHallucination(decision, await reasonsPromise);
          const { data } = await runHallucinationJudge(node, input, provider);
          return { ...mapHallucination(data), ...llmProvenance(gated, `n${nodeIndex}:hallucination`) };
        })(),
        (async () => {
          const decision = g("variable_extraction");
          if (decision) return jevVariables(decision, node, await reasonsPromise).metrics;
          const { data } = await runVariableExtractionJudge(node, input, provider);
          return { ...mapVariableExtraction(data, node.required_variables), ...llmProvenance(gated, `n${nodeIndex}:variable_extraction`) };
        })(),
        (async () => {
          const decision = g("node_loop");
          if (decision) return jevNodeLoop(decision, await reasonsPromise);
          const { data } = await runLoopJudge(node, input, provider);
          return { ...mapNodeLoop(data), ...llmProvenance(gated, `n${nodeIndex}:node_loop`) };
        })(),
        (async () => {
          const decision = g("intent_identification");
          if (decision) return jevIntent(decision, await reasonsPromise);
          const { data } = await runIntentJudge(node, input, provider);
          return { ...data, ...llmProvenance(gated, `n${nodeIndex}:intent_identification`) };
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
          const decision = decided(`m.${spec.name}`);
          if (decision) return jevCustomMetric(spec, decision, await reasonsPromise);
          return await runCustomMetricJudge(spec, input, refOf, provider);
        }
        // Node scope: a node the gate left uncertain is re-judged on its own;
        // the decided ones cost nothing. Roll-up is the shared rule either way.
        const anyDecided = input.nodes.some((_, i) => decided(`m${i}.${spec.name}`));
        if (!anyDecided) return await runCustomMetricJudge(spec, input, refOf, provider);
        return await judgeNodeScopeCustomMetric({ spec, input, refOf, decided, reasonsPromise, provider });
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

/** A node-scope custom metric the gate decided on some nodes and left uncertain
 *  on others: judge only the uncertain ones, then apply the shared roll-up. */
async function judgeNodeScopeCustomMetric(args: {
  spec: CustomJudgeSpec;
  input: ConversationInput;
  refOf: (nodeUuid: string) => string;
  decided: (id: string) => GatedAxis | undefined;
  reasonsPromise: Promise<ReasonMap>;
  provider?: LlmProvider;
}): Promise<CustomMetricVerdict> {
  const { spec, input, refOf, decided, reasonsPromise, provider } = args;
  const perNode: CustomMetricNodeVerdict[] = await Promise.all(
    input.nodes.map(async (node, nodeIndex): Promise<CustomMetricNodeVerdict> => {
      const decision = decided(`m${nodeIndex}.${spec.name}`);
      if (!decision) return judgeCustomMetricNode(spec, node, input, refOf, provider);
      const verdict = jevCustomMetric(spec, decision, await reasonsPromise);
      return {
        ref: refOf(node.node_uuid),
        node_name: node.node_name,
        verdict: verdict.verdict,
        reason: verdict.reason,
        technical_reason: verdict.technical_reason,
      };
    }),
  );
  const rolled = rollUpNodeVerdicts(perNode);
  const decidingIndex = perNode.findIndex((n) => n.verdict === rolled);
  const deciding = decidingIndex >= 0 ? perNode[decidingIndex] : undefined;
  const decidingGate = decidingIndex >= 0 ? decided(`m${decidingIndex}.${spec.name}`) : undefined;
  return {
    judge_name: spec.name,
    display_name: spec.display_name,
    scope: spec.scope,
    verdict: rolled,
    reason: deciding?.reason ?? "",
    technical_reason: deciding?.technical_reason ?? "",
    available: true,
    per_node: perNode,
    ...(decidingGate ? provenanceOf(decidingGate) : LLM),
  };
}
