import type { LlmUsage } from "./types.js";

// Token accounting arithmetic. ONE definition of what it means to add up LlmUsage.
//
// There were three: a mutating accumulator in llm/index.ts (the completeJSON retry
// loop), a pure two-argument merge in evals-engine/judges/variable-extraction.ts,
// and a fold in sim-engine/gen/generate.ts that renamed the fields on its way out
// (`prompt` for `promptTokens`). Three signatures, two vocabularies, one concept —
// and the merge silently dropped reasoningTokens, so a judge that retried lost the
// invisible spend that explains its own truncations.
//
// Everything here speaks the LlmUsage field names. Adding a fourth spelling of
// "prompt tokens" is how a reader ends up unsure whether two numbers are the same
// number.

/** Accumulate `from` into `into`, in place. The hot path: completeJSON calls this
 *  once per attempt, so it avoids allocating a fresh object per retry.
 *
 *  `totalTokens` sums the PROVIDER-REPORTED total rather than recomputing
 *  prompt + completion. The provider is authoritative about its own billing unit,
 *  and where the two disagree we want its number, not our arithmetic. */
export function addUsage(into: LlmUsage, from: LlmUsage): void {
  into.promptTokens += from.promptTokens;
  into.completionTokens += from.completionTokens;
  into.totalTokens += from.totalTokens;
  // Stays absent (rather than becoming 0) when no provider in the set reported it,
  // so "this transport doesn't report reasoning tokens" is distinguishable from
  // "this call did no reasoning".
  if (typeof from.reasoningTokens === "number") {
    into.reasoningTokens = (into.reasoningTokens ?? 0) + from.reasoningTokens;
  }
}

/** A fresh zeroed accumulator. */
export function emptyUsage(): LlmUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/**
 * Fold a set of per-call usages into one total plus the number of calls it came
 * from. A pure fold over `addUsage` — same arithmetic, no second implementation.
 *
 * `calls` is returned ALONGSIDE the usage rather than folded into it, so nothing
 * typed as `LlmUsage` ends up carrying a phantom field. It matters because it is
 * how retry waste stays visible: a chunk that burned three attempts reports
 * calls=3, instead of the extra spend hiding inside a larger total.
 */
export function sumUsage(usages: readonly LlmUsage[]): { usage: LlmUsage; calls: number } {
  const usage = emptyUsage();
  for (const u of usages) addUsage(usage, u);
  return { usage, calls: usages.length };
}
