import { CUSTOM_METRIC_GATE, decide, type JudgeGate } from "../../jev/gates.js";
import { JEV_OVERFLOW, JevError, type JevResponse } from "../../jev/types.js";
import type { JevAxis, JevPlan } from "./plan.js";
import type { NodeEvalInput } from "../types.js";
import { finalBatchContext, finalBatchCoversVariable, lookupBackedVariable, outOfScopeVariableKind } from "../judges/variable-guards.js";

// "review" is the safe default: a dropped request, transport error, overflow,
// invalid answer or uncertain probability hands the axis to its LLM judge. A
// missing answer is never read as a probability, so an unreachable Jev cannot
// invent passes.

export type AxisOutcome = "pass" | "fail" | "review" | "unknown";
export type AxisFallback = "budget" | "overflow" | "error" | "circuit_open" | "unanswered";

export interface GatedAxis {
  axis: JevAxis;
  outcome: AxisOutcome;
  /** Highest probability across the axis's questions; null when unanswered. */
  p: number | null;
  /** Questions at or above the fail threshold (what merge files as the defect). */
  firedKeys: string[];
  probabilities: Record<string, number>;
  fallback?: AxisFallback;
  jevModel?: string;
  /** Deterministically inapplicable questions, excluded BEFORE reduction. */
  ignoredKeys?: string[];
}

const TIME_FIELD = /(^|_)(time|date|datetime|day|when)(_|$)/;
const isTimeField = (name: string): boolean => {
  const snake = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return TIME_FIELD.test(snake) && !/birth|dob/.test(snake);
};

export type RequestResult = { ok: true; response: JevResponse } | { ok: false; error: unknown };

function fallbackFor(error: unknown): AxisFallback {
  if (!(error instanceof JevError)) return "error";
  if (error.status === 400 && error.errorType === JEV_OVERFLOW) return "overflow";
  return error.errorType === "circuit_open" ? "circuit_open" : "error";
}

export function gatePlan(
  plan: JevPlan,
  results: ReadonlyMap<string, RequestResult>,
  gates: Readonly<Record<string, JudgeGate>>,
  nodes: readonly NodeEvalInput[] = [],
): GatedAxis[] {
  const dropped = new Set(plan.dropped.map((d) => d.requestKey));

  return plan.axes.map((axis): GatedAxis => {
    const probabilities: Record<string, number> = {};
    let jevModel: string | undefined;
    const review = (fallback: AxisFallback): GatedAxis => ({ axis, outcome: "review", p: null, firedKeys: [], probabilities, fallback, jevModel });
    if (dropped.has(axis.requestKey)) return review("budget");

    const result = results.get(axis.requestKey);
    if (!result) return review("error");
    if (!result.ok) return review(fallbackFor(result.error));

    jevModel = result.response.model || undefined;
    for (const key of axis.questionKeys) {
      const answer = result.response.answers[key];
      if (answer) probabilities[key] = answer.noul;
    }
    const answered = Object.entries(probabilities);
    if (answered.length === 0) return review("unanswered");

    const gate = gates[axis.kind === "custom" ? CUSTOM_METRIC_GATE : axis.judge];
    if (!gate) return review("unanswered");

    if (axis.kind === "custom") {
      // The fail question's FALSE criterion is "passes OR does not apply", so it
      // needs the applicability answer to tell a clean call from an N/A one.
      const applicable = probabilities[axis.applicableKey];
      if (applicable === undefined) return review("unanswered");
      if (applicable <= gate.pass_below) {
        return { axis, outcome: "unknown", p: applicable, firedKeys: [], probabilities, jevModel };
      }
      if (applicable < gate.fail_above) {
        return { axis, outcome: "review", p: applicable, firedKeys: [], probabilities, jevModel };
      }
      const failP = probabilities[axis.failKey];
      if (failP === undefined) return review("unanswered");
      const outcome = decide(failP, gate);
      return { axis, outcome, p: failP, firedKeys: outcome === "fail" ? [axis.failKey] : [], probabilities, jevModel };
    }

    const ignoredKeys: string[] = [];
    if (axis.kind === "node" && axis.judge === "variable_extraction") {
      const node = nodes[axis.nodeIndex];
      if (node) {
        const batch = finalBatchContext(node);
        for (const ref of axis.variables ?? []) {
          if (outOfScopeVariableKind(ref.variable, node.variable_rules?.[ref.variable]) !== undefined ||
              (!ref.recorded && finalBatchCoversVariable(batch, node, ref.variable))) ignoredKeys.push(ref.key);
        }
      }
    }
    const ignored = new Set(ignoredKeys);
    const required = axis.questionKeys.filter((key) => !ignored.has(key));
    const applicableAnswers = answered.filter(([key]) => !ignored.has(key));
    // Any question firing fails the axis, so p is the max, as benchmarked.
    let p = 0;
    for (const [, value] of applicableAnswers) p = Math.max(p, value);
    let outcome = decide(p, gate);
    // A FAIL needs one question; a PASS needs all: an unanswered or capped-out
    // question was judged by nobody.
    const complete = applicableAnswers.length === required.length && !(axis.kind === "node" && axis.truncated);
    if (outcome === "pass" && !complete) outcome = "review";
    // Jev sees lookup results clipped, so an unrecorded lookup field goes to the
    // LLM, which gets the full result.
    if (outcome === "pass" && axis.kind === "node" && axis.judge === "variable_extraction" &&
        axis.variables?.some((r) => !r.recorded && lookupBackedVariable(nodes[axis.nodeIndex]?.variable_rules?.[r.variable]))) outcome = "review";
    // Jev reads platform idle reminders as the agent repeating itself; the
    // LLM loop judge, which strips them, decides those nodes.
    if (outcome === "fail" && axis.kind === "node" && axis.judge === "node_loop" &&
        nodes[axis.nodeIndex]?.turns?.some((t) => t.idle)) outcome = "review";
    const firedKeys = applicableAnswers.filter(([, value]) => value >= gate.fail_above).map(([key]) => key);
    // Jev has no call clock, so it cannot check "in 30 minutes" resolved to a clock value.
    if (outcome === "fail" && axis.kind === "node" && axis.judge === "variable_extraction" && firedKeys.length > 0 &&
        firedKeys.every((k) => isTimeField(axis.variables?.find((r) => r.key === k)?.variable ?? ""))) outcome = "review";
    return { axis, outcome, p: applicableAnswers.length || !required.length ? p : null, firedKeys, probabilities, jevModel, ignoredKeys };
  });
}

/** Collapse an axis asked across several requests (chunked variable questions)
 *  into one verdict: any failing chunk fails it; a pass needs every chunk to
 *  pass, since an undecided chunk leaves some variable unjudged. */
export function mergeChunkedAxes(gated: readonly GatedAxis[]): GatedAxis[] {
  const groups = new Map<string, GatedAxis[]>();
  const order: string[] = [];
  for (const g of gated) {
    const id = g.axis.id.split("#")[0]!;
    if (!groups.has(id)) { groups.set(id, []); order.push(id); }
    groups.get(id)!.push(g);
  }
  return order.map((id) => {
    const chunks = groups.get(id)!;
    // Normalize the id even for a single chunk: downstream looks the axis up by
    // the judge's own id, never by the request it happened to ride in.
    if (chunks.length === 1) {
      const only = chunks[0]!;
      return only.axis.id === id ? only : { ...only, axis: { ...only.axis, id } };
    }
    const fails = chunks.filter((c) => c.outcome === "fail");
    const outcome: AxisOutcome = fails.length > 0 ? "fail" : chunks.some((c) => c.outcome === "review") ? "review" : "pass";
    const deciding = fails.length > 0 ? fails : chunks;
    const axis = chunks[0]!.axis;
    const merged: GatedAxis = {
      axis: {
        ...axis,
        id,
        questionKeys: chunks.flatMap((c) => c.axis.questionKeys),
        ...(axis.kind === "node" ? { truncated: chunks.some(c => c.axis.kind === "node" && c.axis.truncated) } : {}),
        ...(axis.kind === "node" && axis.variables ? { variables: chunks.flatMap((c) => (c.axis as typeof axis).variables ?? []) } : {}),
      },
      outcome,
      p: deciding.reduce<number | null>((max, c) => (c.p === null ? max : Math.max(max ?? -1, c.p)), null),
      firedKeys: deciding.flatMap((c) => c.firedKeys),
      probabilities: Object.assign({}, ...chunks.map((c) => c.probabilities)),
      ignoredKeys: chunks.flatMap((c) => c.ignoredKeys ?? []),
      ...(chunks.find((c) => c.fallback) ? { fallback: chunks.find((c) => c.fallback)!.fallback } : {}),
      ...(chunks.find((c) => c.jevModel) ? { jevModel: chunks.find((c) => c.jevModel)!.jevModel } : {}),
    };
    return merged;
  });
}

export function byAxisId(gated: readonly GatedAxis[]): Map<string, GatedAxis> {
  return new Map(gated.map((g) => [g.axis.id, g]));
}
