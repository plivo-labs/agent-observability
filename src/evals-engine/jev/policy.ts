import type { JudgeGate } from "../../jev/gates.js";
import type { JudgeProvenance } from "../types.js";
import type { GatedAxis } from "./gate.js";
import { EVIDENCE_VERSION } from "./evidence.js";

export const POLICY_VERSION = "verify-failures-v2";
export const QUESTION_VERSION = "jev-questions-v1";
export type ReviewRoute = "auto_pass" | "verify_failure" | "verify_applicability" | "uncalibrated_evidence" | "uncertain_or_incomplete";

/** Gates produce candidates; policy decides who may publish the final verdict.
 * Node evidence and custom applicability need held-out calibration before
 * automatic acceptance. Changing gate thresholds cannot bypass this policy. */
export function routeAxis(g: GatedAxis): ReviewRoute {
  if (g.outcome === "fail") return "verify_failure";
  if (g.outcome === "unknown") return "verify_applicability";
  if (g.outcome === "review") return "uncertain_or_incomplete";
  return g.axis.kind === "conversation" ? "auto_pass" : "uncalibrated_evidence";
}

export function decisionProvenance(g: GatedAxis | undefined, gate?: JudgeGate): JudgeProvenance {
  if (!g) return { backend: "llm" };
  const route = routeAxis(g);
  return {
    backend: route === "auto_pass" ? "jev" : "llm",
    ...(route === "auto_pass" && g.p !== null ? { confidence: g.p } : {}),
    ...(g.jevModel ? { jev_model: g.jevModel } : {}),
    jev: {
      candidate: g.outcome,
      probability: g.p,
      probabilities: g.probabilities,
      question_keys: g.axis.questionKeys,
      ignored_keys: g.ignoredKeys ?? [],
      missing_keys: g.axis.questionKeys.filter(k => g.probabilities[k] === undefined && !g.ignoredKeys?.includes(k)),
      truncated: g.axis.kind === "node" && !!g.axis.truncated,
      ...(gate ? { gate } : {}),
      ...(g.fallback ? { fallback: g.fallback } : {}),
      route,
      evidence_version: g.axis.kind === "conversation" ? "speech-v1" : EVIDENCE_VERSION,
      question_version: QUESTION_VERSION,
      policy_version: POLICY_VERSION,
    },
  };
}
