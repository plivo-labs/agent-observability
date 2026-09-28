import type {
  CmDetection,
  HallucinationMetrics,
  InstructionsAdherenceMetrics,
  IntentIdentificationMetrics,
  JudgeProvenance,
  NodeEvalInput,
  NodeLoopMetrics,
  SimConversationMetrics,
  VariableExtractionMetrics,
} from "../types.js";
import type { DetectionResult } from "../judges/conversation-judges.js";
import type { CustomMetricVerdict, CustomJudgeSpec, CustomMetricNodeVerdict } from "../judges/custom-metric.js";
import { clamp01 } from "../aggregate.js";
import type { GatedAxis } from "./gate.js";
import type { JevNodeAxis } from "./plan.js";
import { INTENT_WRONG_KEY } from "../../jev/questions.js";

// Turning a gated probability into the verdict blocks consumers already read.
// Two rules hold everywhere:
//   * the SHAPE is the one the LLM judges produce, so the stored blob, the
//     fan-out `raw`, and every consumer keep working unchanged;
//   * a Jev-decided block says so — `backend`/`confidence`/`jev_model` — because
//     a mixed Jev/LLM dataset with no provenance is invisible in the data
//     (the cost this repo already documents for JUDGE_MODEL_FALLBACK).

export interface ReasonText {
  reason: string;
  technical_reason: string;
}
export type ReasonMap = ReadonlyMap<string, ReasonText>;

const round = (p: number): string => p.toFixed(2);

export function provenanceOf(g: GatedAxis): JudgeProvenance {
  return { confidence: g.p ?? undefined, backend: "jev", ...(g.jevModel ? { jev_model: g.jevModel } : {}) };
}

/** A confident pass costs no LLM call, so its text is templated. The score stays
 *  out of `reason`: that string is read by customers, to whom a bare model
 *  probability means nothing. It lives in `technical_reason` instead. */
export function passReason(g: GatedAxis): ReasonText {
  return {
    reason: "No defect found.",
    technical_reason: `jev: p=${round(g.p ?? 0)} at or below this judge's pass threshold`,
  };
}

/** A metric the call never reached rides the same batched call as the fails:
 *  a useful N/A names the situation that was expected and what happened
 *  instead, which is per-session evidence a template cannot carry. */
export function naReason(g: GatedAxis, reasons: ReasonMap): ReasonText {
  const written = reasons.get(g.axis.id);
  if (written?.reason) {
    return {
      reason: written.reason,
      technical_reason: `jev ${round(g.p ?? 0)} · ${written.technical_reason}`,
    };
  }
  return {
    reason: "This metric did not apply: the call never reached the situation it describes.",
    technical_reason: `jev: applicability p=${round(g.p ?? 0)} at or below this judge's pass threshold; reason writer unavailable`,
  };
}

/** A confident fail's explanation is written by the LLM in one batched call;
 *  if that call failed we still keep the verdict and say so plainly rather
 *  than inventing evidence. */
export function failReason(g: GatedAxis, reasons: ReasonMap): ReasonText {
  const written = reasons.get(g.axis.id);
  if (written) {
    return {
      reason: written.reason,
      technical_reason: `jev ${round(g.p ?? 0)} · ${written.technical_reason}`,
    };
  }
  return {
    reason: "A defect was detected; explanation unavailable.",
    technical_reason: `jev: p=${round(g.p ?? 0)} at or above this judge's fail threshold; reason writer unavailable`,
  };
}

export function textFor(g: GatedAxis, reasons: ReasonMap): ReasonText {
  return g.outcome === "fail" ? failReason(g, reasons) : passReason(g);
}

// ── node axes ────────────────────────────────────────────────────────────────

/** Sub-rubrics stay null: AO did not compute them on this path, and filling
 *  them with a reason-less 1.0 would read downstream as a graded rubric.
 *  `score` carries Jev's confidence, `adherence_passed` the verdict. */
export function jevAdherence(g: GatedAxis, reasons: ReasonMap): InstructionsAdherenceMetrics {
  const t = textFor(g, reasons);
  return {
    adherence_passed: g.outcome !== "fail",
    score: clamp01(1 - (g.p ?? 0)),
    reason: t.reason,
    technical_reason: t.technical_reason,
    objective_progress: null,
    procedure_compliance: null,
    interaction_quality: null,
    policy_boundary_compliance: null,
    ...provenanceOf(g),
  };
}

export function jevIntent(g: GatedAxis, reasons: ReasonMap): IntentIdentificationMetrics {
  const t = textFor(g, reasons);
  const axis = g.axis as JevNodeAxis;
  const fired = new Set(g.firedKeys);
  // Catalog coverage and recorded-selection correctness map to separate flags.
  const isWrongQuestion = (key: string): boolean => key.endsWith(`.${INTENT_WRONG_KEY}`);
  const wrong = axis.intents?.some((i) => isWrongQuestion(i.key) && fired.has(i.key)) ?? false;
  const missed = axis.intents?.some((i) => !isWrongQuestion(i.key) && fired.has(i.key)) ?? false;
  const failed = g.outcome === "fail";
  return {
    // Preserve rubric precedence even if independent questions both fire.
    // The empty-key fallback retains compatibility with legacy gated results.
    intent_not_found: failed && (missed || (!wrong && g.firedKeys.length === 0)),
    intent_wrongly_identified: failed && wrong && !missed,
    score: failed ? 0 : 1,
    reason: t.reason,
    technical_reason: t.technical_reason,
    ...provenanceOf(g),
  };
}

export interface JevVariableOutcome {
  metrics: VariableExtractionMetrics;
  /** Names the deterministic guards cleared — the fail became a pass. */
  cleared: string[];
}

/** Render a final variable decision. Applicability exclusions belong in the
 * gate, before coverage is reduced; clearing a failure here could otherwise
 * turn an unanswered sibling question into a clean pass. */
export function jevVariables(g: GatedAxis, node: NodeEvalInput, reasons: ReasonMap): JevVariableOutcome {
  if (g.outcome === "review") throw new Error("Cannot render an unresolved variable decision");
  const axis = g.axis as JevNodeAxis;
  const fired = new Set(g.firedKeys);
  const names = (axis.variables ?? []).filter((v) => fired.has(v.key));
  const ignored = new Set(g.ignoredKeys ?? []);
  const cleared = (axis.variables ?? []).filter((v) => ignored.has(v.key)).map((v) => v.variable);
  const missing: string[] = [];
  const incorrect: string[] = [];
  for (const v of names) {
    (v.recorded ? incorrect : missing).push(v.variable);
  }
  const failed = g.outcome === "fail" && missing.length + incorrect.length > 0;
  const t = failed
    ? failReason(g, reasons)
    : cleared.length > 0
      ? {
          reason: "All applicable caller-provided variables were captured correctly.",
          technical_reason: `jev: p=${round(g.p ?? 0)}; cleared as out-of-scope or pending the final recording batch: ${cleared.join(", ")}`,
        }
      : passReason(g);
  return {
    metrics: {
      extraction_successful: !failed,
      score: failed ? clamp01(1 - (g.p ?? 0)) : 1,
      reason: t.reason,
      technical_reason: t.technical_reason,
      // Authoritative from config, exactly as the LLM path re-attaches it.
      required_variables: node.required_variables,
      missing_variables: failed ? missing : [],
      incorrect_variables: failed ? incorrect : [],
      ...provenanceOf(g),
    },
    cleared,
  };
}

export function jevHallucination(g: GatedAxis, reasons: ReasonMap): HallucinationMetrics {
  const t = textFor(g, reasons);
  return {
    hallucinated: g.outcome === "fail",
    score: clamp01(1 - (g.p ?? 0)),
    reason: t.reason,
    technical_reason: t.technical_reason,
    ...provenanceOf(g),
  };
}

export function jevNodeLoop(g: GatedAxis, reasons: ReasonMap): NodeLoopMetrics {
  const t = textFor(g, reasons);
  return {
    loop_detected: g.outcome === "fail",
    score: clamp01(1 - (g.p ?? 0)),
    reason: t.reason,
    technical_reason: t.technical_reason,
    ...provenanceOf(g),
  };
}

// ── conversation axis ────────────────────────────────────────────────────────

/** A Jev-decided detection in the raw shape resolveOutcomes consumes, so the
 *  priority ladder and every downstream rule work on it unchanged. */
export function jevDetection(g: GatedAxis, reasons: ReasonMap): DetectionResult {
  const t = textFor(g, reasons);
  return { detected: g.outcome === "fail", reason: t.reason, technical_reason: t.technical_reason, available: true };
}

const SUPERSEDED = "superseded by a higher-priority conversation outcome";
const CODE_DERIVED = "derived in code:";

/**
 * Stamp provenance onto the emitted conversation metrics.
 *
 * Only where the emitted verdict IS the backend's verdict: a detection the
 * priority ladder overruled, or one code derived (the silent-call
 * low-engagement), is a CODE decision, and labelling it `jev 0.93` would store
 * the opposite of what happened.
 */
export function attachDetectionProvenance(
  metrics: SimConversationMetrics,
  provenance: ReadonlyMap<keyof SimConversationMetrics, JudgeProvenance>,
): SimConversationMetrics {
  const out = { ...metrics };
  for (const [key, p] of provenance) {
    const current = out[key] as CmDetection | undefined;
    if (!current || typeof current.detected !== "boolean") continue;
    const overruled = current.technical_reason === SUPERSEDED || current.technical_reason.startsWith(CODE_DERIVED);
    (out[key] as CmDetection) = overruled ? { ...current, ...(p.jev ? { jev: p.jev, jev_model: p.jev_model } : {}), backend: "code" } : { ...current, ...p };
  }
  return out;
}

// ── custom metrics ───────────────────────────────────────────────────────────

export function jevCustomMetric(
  spec: CustomJudgeSpec,
  g: GatedAxis,
  reasons: ReasonMap,
  perNode?: CustomMetricNodeVerdict[],
): CustomMetricVerdict {
  const verdict = g.outcome === "fail" ? "fail" : g.outcome === "unknown" ? "unknown" : "pass";
  const t =
    verdict === "fail"
      ? failReason(g, reasons)
      : verdict === "unknown"
        ? naReason(g, reasons)
        : passReason(g);
  return {
    judge_name: spec.name,
    display_name: spec.display_name,
    scope: spec.scope,
    verdict,
    reason: t.reason,
    technical_reason: t.technical_reason,
    available: true,
    ...(perNode ? { per_node: perNode } : {}),
    ...provenanceOf(g),
  };
}
