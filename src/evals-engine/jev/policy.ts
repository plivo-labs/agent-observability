import type { JudgeGate } from "../../jev/gates.js";
import type { JudgeProvenance } from "../types.js";
import type { GatedAxis } from "./gate.js";
import { EVIDENCE_VERSION } from "./evidence.js";
import { CONVERSATION_JUDGES, NODE_JUDGES } from "./plan.js";

export const POLICY_VERSION = "verify-failures-v3";
export const QUESTION_VERSION = "jev-node-questions-v4";
export type ReviewRoute = "auto_pass" | "auto_fail" | "verify_failure" | "verify_applicability" | "uncalibrated_evidence" | "uncertain_or_incomplete";

/** Which confident Jev outcomes may be published without a full LLM judge. */
export interface RoutePolicy {
  /** Node judges whose confident pass stands. Conversation passes always do. */
  nodeAutoPass: ReadonlySet<string>;
  /** Judges whose confident fail stands; the LLM then only writes the reason. */
  autoFail: ReadonlySet<string>;
}
const NONE: ReadonlySet<string> = new Set();
export const REVIEW_ALL: RoutePolicy = { nodeAutoPass: NONE, autoFail: NONE };

/** "off", "all", or a comma-separated list drawn from `allowed`. Unknown names
 *  are reported so a typo cannot silently keep a judge on LLM review. */
export function parseJudgeList(raw: string | undefined, allowed: readonly string[]): { judges: ReadonlySet<string>; unknown: string[] } {
  const value = (raw ?? "off").trim();
  if (!value || value === "off") return { judges: NONE, unknown: [] };
  if (value === "all") return { judges: new Set(allowed), unknown: [] };
  const names = value.split(",").map((n) => n.trim()).filter(Boolean);
  return { judges: new Set(names.filter((n) => allowed.includes(n))), unknown: names.filter((n) => !allowed.includes(n)) };
}
export const AUTO_PASS_JUDGES: readonly string[] = NODE_JUDGES;
export const AUTO_FAIL_JUDGES: readonly string[] = [...CONVERSATION_JUDGES, ...NODE_JUDGES];

/** Gates produce candidates; policy decides who may publish the final verdict.
 * A confident outcome is published only for the judges `policy` names —
 * conversation passes always — and custom metrics are never published by Jev.
 * Everything uncertain, and every confident outcome not named, gets a full
 * independent LLM judge. Changing gate thresholds cannot bypass this policy. */
export function routeAxis(g: GatedAxis, policy: RoutePolicy = REVIEW_ALL): ReviewRoute {
  if (g.outcome === "fail") return g.axis.kind !== "custom" && policy.autoFail.has(g.axis.judge) ? "auto_fail" : "verify_failure";
  if (g.outcome === "unknown") return "verify_applicability";
  if (g.outcome === "review") return "uncertain_or_incomplete";
  if (g.axis.kind === "conversation") return "auto_pass";
  if (g.axis.kind !== "node" || !policy.nodeAutoPass.has(g.axis.judge)) return "uncalibrated_evidence";
  // Only a fired intent can be premature. Without a question on the fired
  // intent's own condition its margin is thin (real defect at 0.31 vs a 0.23
  // pass line), so the LLM checks those.
  return g.axis.intentFired && !g.axis.firedChecked ? "uncalibrated_evidence" : "auto_pass";
}

export const isPublished = (route: ReviewRoute): boolean => route === "auto_pass" || route === "auto_fail";

export function decisionProvenance(g: GatedAxis | undefined, gate?: JudgeGate, policy: RoutePolicy = REVIEW_ALL, layout?: string): JudgeProvenance {
  if (!g) return { backend: "llm" };
  const route = routeAxis(g, policy);
  return {
    backend: isPublished(route) ? "jev" : "llm",
    ...(isPublished(route) && g.p !== null ? { confidence: g.p } : {}),
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
      question_version: g.axis.kind === "node" ? QUESTION_VERSION : "jev-questions-v1",
      policy_version: POLICY_VERSION,
      ...(layout ? { layout } : {}),
    },
  };
}
