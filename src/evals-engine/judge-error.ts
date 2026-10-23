import { classifyErrorDurability } from "../error-durability.js";
import type { LlmUsage } from "../llm/index.js";
import type { NodeEvaluation } from "./types.js";

/** What an axis holds when its judge failed for a reason a retry would not
 *  fix. The axis's own fields are absent, so no verdict can be read out of it. */
export interface JudgeErrorMarker {
  available: false;
  judge_error: string;
  reason: string;
  technical_reason: string;
}

export type OrJudgeError<T> = T | (JudgeErrorMarker & { [K in Exclude<keyof T, keyof JudgeErrorMarker>]?: undefined });

type NodeAxis = "instructions_adherence" | "intent_identification" | "variable_extraction" | "hallucination" | "node_loop";

export type SessionNodeEvaluation = Omit<NodeEvaluation, NodeAxis> & { [K in NodeAxis]: OrJudgeError<NodeEvaluation[K]> };

export function isJudgeError(axis: unknown): axis is JudgeErrorMarker {
  return typeof axis === "object" && axis !== null && typeof (axis as JudgeErrorMarker).judge_error === "string";
}

/** Shared by one session's judges, counted from raw judge results before any
 *  outcome is derived, so a value decided in code never counts as judged. */
export interface JudgeTally {
  modelVerdicts: number;
  errors: unknown[];
}

export const newJudgeTally = (): JudgeTally => ({ modelVerdicts: 0, errors: [] });

/** A session no model judged is an error as a whole; unknowns would hide it. */
export function assertSomethingJudged(tally: JudgeTally): void {
  if (tally.errors.length > 0 && tally.modelVerdicts === 0) throw tally.errors[0];
}

/** Code-decided skips report zero usage and prove nothing about the model. */
export const modelAnswered = (usage: LlmUsage): boolean => usage.totalTokens > 0;

export async function settle<T>(tally: JudgeTally, work: Promise<T>, onError: (e: unknown) => T): Promise<T> {
  try {
    return await work;
  } catch (e) {
    // Settling a transient failure would drop the verdict for good; rethrown,
    // the whole session is retried.
    if (classifyErrorDurability(e) === "transient") throw e;
    console.error(`[evals] judge failed for good, settled without its verdict: ${(e as Error)?.message ?? e}`);
    tally.errors.push(e);
    return onError(e);
  }
}

export function settleAxis<T>(tally: JudgeTally, work: Promise<{ value: T; modelVerdict: boolean }>): Promise<OrJudgeError<T>> {
  const counted = work.then(({ value, modelVerdict }): OrJudgeError<T> => {
    if (modelVerdict) tally.modelVerdicts++;
    return value;
  });
  return settle(tally, counted, (e) => {
    const marker: JudgeErrorMarker = { available: false, ...judgeErrorFields(e) };
    return marker as OrJudgeError<T>;
  });
}

export function judgeErrorFields(e: unknown): Omit<JudgeErrorMarker, "available"> {
  const cls = judgeErrorClass(e);
  return { judge_error: cls, reason: `judge error: ${cls}`, technical_reason: (e as Error)?.message ?? String(e) };
}

function judgeErrorClass(e: unknown): string {
  let text = "";
  for (let cur = e, depth = 0; cur instanceof Error && depth < 5; cur = (cur as { cause?: unknown }).cause, depth++) {
    if (cur.name === "ZodError") return "schema";
    text += ` ${cur.message}`;
  }
  if (text.includes("max_output_tokens")) return "truncated";
  if (/content.?(filter|policy|management)/i.test(text)) return "content_filter";
  if (text.includes("invalid JSON")) return "invalid_json";
  return "error";
}
