import { decide, gateFor, type JudgeGate } from "../../jev/gates.js";
import { JEV_OVERFLOW, JevError, type JevResponse } from "../../jev/types.js";
import type { JevAxis, JevPlan } from "./plan.js";

// Turn Jev's probabilities into a decision per axis. Pure: the caller does the
// I/O and hands in what each request returned.
//
// "review" is the safe default — a dropped request, a transport error, an
// overflow, an answer that failed validation, or simply a probability in the
// uncertain band all mean the judge that owns the axis runs as it does today.
// A missing answer is NEVER read as a probability: that is how an unreachable
// Jev degrades to today's behaviour instead of inventing passes.

export type AxisOutcome = "pass" | "fail" | "review" | "unknown";
export type AxisFallback = "budget" | "overflow" | "error" | "unanswered";

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
}

export type RequestResult = { ok: true; response: JevResponse } | { ok: false; error: unknown };

function fallbackFor(error: unknown): AxisFallback {
  return error instanceof JevError && error.status === 400 && error.errorType === JEV_OVERFLOW ? "overflow" : "error";
}

export function gatePlan(
  plan: JevPlan,
  results: ReadonlyMap<string, RequestResult>,
  gates: Readonly<Record<string, JudgeGate>>,
): GatedAxis[] {
  const dropped = new Set(plan.dropped.map((d) => d.requestKey));

  return plan.axes.map((axis): GatedAxis => {
    const review = (fallback: AxisFallback): GatedAxis => ({ axis, outcome: "review", p: null, firedKeys: [], probabilities: {}, fallback });
    if (dropped.has(axis.requestKey)) return review("budget");

    const result = results.get(axis.requestKey);
    if (!result) return review("error");
    if (!result.ok) return review(fallbackFor(result.error));

    const probabilities: Record<string, number> = {};
    for (const key of axis.questionKeys) {
      const answer = result.response.answers[key];
      if (answer) probabilities[key] = answer.noul;
    }
    const answered = Object.entries(probabilities);
    if (answered.length === 0) return review("unanswered");

    const gate = gateFor(gates, axis.judge);
    // A judge with no gate is not Jev's to decide.
    if (!gate) return review("unanswered");

    const jevModel = result.response.model || undefined;

    if (axis.kind === "custom") {
      // "Did the call even reach this metric's situation?" is asked first: a
      // metric that never applied is `unknown`, which is neither a pass nor a
      // fail and costs no LLM call — the same contract the LLM judge has.
      const applicable = probabilities[axis.applicableKey];
      if (applicable !== undefined && applicable <= gate.pass_below) {
        return { axis, outcome: "unknown", p: applicable, firedKeys: [], probabilities, jevModel };
      }
      const failP = probabilities[axis.failKey];
      if (failP === undefined) return review("unanswered");
      const outcome = decide(failP, gate);
      return { axis, outcome, p: failP, firedKeys: outcome === "fail" ? [axis.failKey] : [], probabilities, jevModel };
    }

    // Any question firing fails the axis, so the axis's probability is the
    // highest of its questions — the same aggregation the benchmark scored.
    let p = -1;
    for (const [, value] of answered) p = Math.max(p, value);
    const outcome = decide(p, gate);
    const firedKeys = answered.filter(([, value]) => value >= gate.fail_above).map(([key]) => key);
    return { axis, outcome, p, firedKeys, probabilities, jevModel };
  });
}

/**
 * Collapse an axis that was asked across several requests (the chunked variable
 * questions) into the one verdict the judge owns.
 *
 * Any chunk failing fails the axis — the questions are independent defects. A
 * pass needs EVERY chunk to pass: an unanswered or uncertain chunk means some
 * variable was never decided, so the axis goes to review rather than claiming a
 * clean call on partial evidence.
 */
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
        ...(axis.kind === "node" && axis.variables ? { variables: chunks.flatMap((c) => (c.axis as typeof axis).variables ?? []) } : {}),
      },
      outcome,
      p: deciding.reduce<number | null>((max, c) => (c.p === null ? max : Math.max(max ?? -1, c.p)), null),
      firedKeys: deciding.flatMap((c) => c.firedKeys),
      probabilities: Object.assign({}, ...chunks.map((c) => c.probabilities)),
      ...(chunks.find((c) => c.fallback) ? { fallback: chunks.find((c) => c.fallback)!.fallback } : {}),
      ...(chunks.find((c) => c.jevModel) ? { jevModel: chunks.find((c) => c.jevModel)!.jevModel } : {}),
    };
    return merged;
  });
}

/** Index by axis id for the merge step. */
export function byAxisId(gated: readonly GatedAxis[]): Map<string, GatedAxis> {
  return new Map(gated.map((g) => [g.axis.id, g]));
}
