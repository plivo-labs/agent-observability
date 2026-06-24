// AO Simulation Engine — stress injection (interruption / non-answer / STT noise).
//
// Port of the stress logic in cx-sqs-worker `usecases/simulation_eval/scenario_runner.go`:
//   - shouldInterrupt        (L171-193)
//   - shouldInjectNonAnswer  (L195-216)
//   - pickNonAnswerType      (L218-223)
//   - truncateMidSpeech      (L117-168)  — simulates TTS cancellation (the "partial" the
//                                          interrupted caller heard).
// MinWordsForInterruption = 8 (models.go L22).
//
// In Go these are methods on ScenarioRunner reading runner fields + package `math/rand`.
// Here they are PURE functions: the per-turn state each gate needs is passed in explicitly,
// and the RNG is INJECTABLE (`rng: () => number`, default Math.random) so tests are
// deterministic. `rng()` stands in for Go's `rand.Float64()` (range [0,1)); the
// `randIntn(n)` helper stands in for `rand.Intn(n)` (integer in [0, n)).

import type { z } from "zod";
// schema.ts exports these as Zod values (no `export type` alias); infer the static types.
import type { InterruptionConfig as InterruptionConfigSchema, NonAnswerConfig as NonAnswerConfigSchema } from "../schema.js";
import type { ConversationTurn } from "./user-simulator.js";

type InterruptionConfig = z.infer<typeof InterruptionConfigSchema>;
type NonAnswerConfig = z.infer<typeof NonAnswerConfigSchema>;

/** A caller's previous assistant message must be at least this many words before the
 *  simulator is allowed to "interrupt" it (a 2-word "Got it." is never interruptible).
 *  Mirrors Go `MinWordsForInterruption`. */
export const MIN_WORDS_FOR_INTERRUPTION = 8;

/** Injectable RNG: returns a float in [0, 1), like Go's `rand.Float64()`. */
export type Rng = () => number;

/** `rand.Intn(n)` equivalent: an integer in [0, n). rng()=0 → 0; rng()→1 → n-1. */
function randIntn(n: number, rng: Rng): number {
  return Math.floor(rng() * n);
}

/** Whitespace-split word count, matching Go's `len(strings.Fields(s))` (collapses runs,
 *  ignores leading/trailing whitespace). */
function wordCount(s: string): number {
  const t = s.trim();
  if (t === "") return 0;
  return t.split(/\s+/).length;
}

/** The per-turn state the interruption gate inspects (the subset of ScenarioRunner it reads). */
export interface InterruptionState {
  config: InterruptionConfig;
  conversationHistory: ConversationTurn[];
  isNodeSwitch: boolean;
  turnIndex: number;
  lastTurnWasInterruption: boolean;
}

/**
 * Decide whether to simulate an interruption on this turn. Faithful port of
 * `shouldInterrupt` — ALL guards must pass before the probability roll, in this order:
 *   1. interruption enabled,
 *   2. not the opening turn (turnIndex !== 0) and history is non-empty,
 *   3. not a node switch,
 *   4. the previous turn was not itself an interruption (no back-to-back),
 *   5. the last history message is from the assistant,
 *   6. that message has >= MIN_WORDS_FOR_INTERRUPTION words,
 * then fire iff `rng() < probability`.
 */
export function shouldInterrupt(state: InterruptionState, rng: Rng = Math.random): boolean {
  if (!state.config.enabled) return false;
  if (state.turnIndex === 0 || state.conversationHistory.length === 0) return false;
  if (state.isNodeSwitch) return false;
  if (state.lastTurnWasInterruption) return false;

  const lastMsg = state.conversationHistory[state.conversationHistory.length - 1];
  if (lastMsg.role !== "assistant") return false;
  if (wordCount(lastMsg.content) < MIN_WORDS_FOR_INTERRUPTION) return false;

  return rng() < state.config.probability;
}

/** The per-turn state the non-answer gate inspects. */
export interface NonAnswerState {
  config: NonAnswerConfig;
  conversationHistory: ConversationTurn[];
  isNodeSwitch: boolean;
  turnIndex: number;
  lastTurnWasNonAnswer: boolean;
  lastTurnWasInterruption: boolean;
}

/**
 * Decide whether to inject a non-answer on this turn. Faithful port of
 * `shouldInjectNonAnswer` — guards (in order):
 *   1. non-answer enabled,
 *   2. turnIndex > 1 and history length >= 2 (needs a couple of real turns first),
 *   3. not a node switch,
 *   4. the previous turn was not a non-answer,
 *   5. the previous turn was not an interruption,
 *   6. the last history message is from the assistant AND non-blank,
 * then fire iff `rng() < probability`.
 *
 * Non-answer and interruption are mutually exclusive; the caller checks non-answer FIRST
 * (matching ExecuteAINode), so an interruption is only considered when this returns false.
 */
export function shouldInjectNonAnswer(state: NonAnswerState, rng: Rng = Math.random): boolean {
  if (!state.config.enabled) return false;
  if (state.turnIndex <= 1 || state.conversationHistory.length < 2) return false;
  if (state.isNodeSwitch) return false;
  if (state.lastTurnWasNonAnswer) return false;
  if (state.lastTurnWasInterruption) return false;

  const lastMsg = state.conversationHistory[state.conversationHistory.length - 1];
  if (lastMsg.role !== "assistant" || lastMsg.content.trim() === "") return false;

  return rng() < state.config.probability;
}

/** Non-answer flavor. Mirrors Go `pickNonAnswerType`: `rng() < 0.5` → presence_check, else topic_lock. */
export type NonAnswerType = "presence_check" | "topic_lock";
export function pickNonAnswerType(rng: Rng = Math.random): NonAnswerType {
  return rng() < 0.5 ? "presence_check" : "topic_lock";
}

/** A ratio in [0.3, 0.7) for how far into the assistant's message TTS got cut off. Mirrors
 *  the inline `0.3 + rand.Float64()*0.4` in ExecuteAINode. Exposed so the runner can roll it
 *  with the same injectable rng. */
export function interruptionRatio(rng: Rng = Math.random): number {
  return 0.3 + rng() * 0.4;
}

/**
 * Simulate TTS cancellation by cutting the bot's response at a natural-ish point. Faithful
 * port of `truncateMidSpeech`:
 *   - <= 3 words: returned unchanged (too short to meaningfully truncate).
 *   - Otherwise: find the target index (ratio * wordCount, clamped to [2, len-1]).
 *   - Walk back from the target to the last clause boundary (a word ending in `,`/`.`/`;`,
 *     or the word "and" case-insensitively).
 *   - If a boundary was found, advance 1-3 words past it (the bot keeps talking briefly
 *     before the cancel); else cut at the target.
 *   - The last kept word is rendered incomplete: if it's > 3 runes, keep its first 1-3
 *     characters; otherwise append "--".
 *
 * Uses Go word semantics (`strings.Fields`) and rune counts (so multi-byte chars count as
 * one), and the injectable rng for the two `rand.Intn(3)` rolls.
 */
export function truncateMidSpeech(text: string, ratio: number, rng: Rng = Math.random): string {
  const words = text.trim() === "" ? [] : text.trim().split(/\s+/);
  if (words.length <= 3) return text;

  let targetIdx = Math.floor(words.length * ratio);
  if (targetIdx < 2) targetIdx = 2;
  if (targetIdx >= words.length) targetIdx = words.length - 1;

  // Find last clause boundary (comma, period, semicolon, or "and") before/at target.
  let boundaryIdx = -1;
  for (let i = targetIdx; i >= 1; i--) {
    const w = words[i - 1];
    if (w.endsWith(",") || w.endsWith(".") || w.endsWith(";") || w.toLowerCase() === "and") {
      boundaryIdx = i;
      break;
    }
  }

  let cutIdx: number;
  if (boundaryIdx > 0) {
    const advance = 1 + randIntn(3, rng); // 1-3 words past the boundary
    cutIdx = boundaryIdx + advance;
    if (cutIdx >= words.length) cutIdx = words.length - 1;
  } else {
    cutIdx = targetIdx;
  }

  // Keep words up to cutIdx (exclusive); the word at cutIdx is truncated to show incompleteness.
  const kept = words.slice(0, cutIdx);
  const lastWord = words[cutIdx];

  // Rune count (Go `utf8.RuneCountInString`): spread iterates by code point, like Go runes.
  const runes = Array.from(lastWord);
  if (runes.length > 3) {
    const cutChars = 1 + randIntn(3, rng); // keep first 1-3 chars of the last word
    kept.push(runes.slice(0, cutChars).join(""));
  } else {
    kept.push(lastWord + "--");
  }

  return kept.join(" ");
}
