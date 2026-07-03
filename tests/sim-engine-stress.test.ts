import { describe, test, expect } from "bun:test";
import {
  shouldInterrupt,
  shouldInjectNonAnswer,
  pickNonAnswerType,
  truncateMidSpeech,
  interruptionRatio,
  MIN_WORDS_FOR_INTERRUPTION,
  type InterruptionState,
  type NonAnswerState,
} from "../src/sim-engine/run-engine/stress.js";
import type { ConversationTurn } from "../src/sim-engine/run-engine/user-simulator.js";

// Deterministic RNGs. Go's rand.Float64() is [0,1): rng()=0 fires any positive-probability
// gate; rng()=1 never fires (1 < prob is false for prob<=1). Tests force both extremes.
const ZERO = () => 0;
const ONE = () => 1;

const LONG_ASSISTANT = "Hi there, how can I help you today with your inquiry about the account?"; // 12 words ≥ 8
const SHORT_ASSISTANT = "Got it."; // 2 words < 8

function history(...turns: [string, string][]): ConversationTurn[] {
  return turns.map(([role, content]) => ({ role, content }));
}

describe("MIN_WORDS_FOR_INTERRUPTION", () => {
  test("is 8 (models.go parity)", () => {
    expect(MIN_WORDS_FOR_INTERRUPTION).toBe(8);
  });
});

describe("shouldInterrupt — gates (port of shouldInterrupt + RNG extremes)", () => {
  const base = (over: Partial<InterruptionState> = {}): InterruptionState => ({
    config: { enabled: true, probability: 1.0 },
    conversationHistory: history(["user", "hello"], ["assistant", LONG_ASSISTANT]),
    isNodeSwitch: false,
    turnIndex: 1,
    lastTurnWasInterruption: false,
    ...over,
  });

  test("fires when all gates pass and rng() < probability (rng=0, prob=1)", () => {
    expect(shouldInterrupt(base(), ZERO)).toBe(true);
  });

  test("does NOT fire when rng() >= probability (rng=1)", () => {
    expect(shouldInterrupt(base(), ONE)).toBe(false);
  });

  test("does NOT fire when probability is 0 even with rng=0 (0 < 0 is false)", () => {
    expect(shouldInterrupt(base({ config: { enabled: true, probability: 0 } }), ZERO)).toBe(false);
  });

  test("disabled scenario never interrupts", () => {
    expect(shouldInterrupt(base({ config: { enabled: false, probability: 1.0 } }), ZERO)).toBe(false);
  });

  test("first turn (turnIndex 0) never interrupts", () => {
    expect(shouldInterrupt(base({ turnIndex: 0 }), ZERO)).toBe(false);
  });

  test("empty history never interrupts", () => {
    expect(shouldInterrupt(base({ conversationHistory: [] }), ZERO)).toBe(false);
  });

  test("node switch never interrupts", () => {
    expect(shouldInterrupt(base({ isNodeSwitch: true }), ZERO)).toBe(false);
  });

  test("no back-to-back interruptions (lastTurnWasInterruption guard)", () => {
    expect(shouldInterrupt(base({ lastTurnWasInterruption: true }), ZERO)).toBe(false);
  });

  test("last message must be from the assistant", () => {
    const h = history(["assistant", LONG_ASSISTANT], ["user", "and one more thing here please now"]);
    expect(shouldInterrupt(base({ conversationHistory: h }), ZERO)).toBe(false);
  });

  test("short assistant message (< 8 words) is not interruptible", () => {
    const h = history(["user", "hello"], ["assistant", SHORT_ASSISTANT]);
    expect(shouldInterrupt(base({ conversationHistory: h }), ZERO)).toBe(false);
  });
});

describe("shouldInjectNonAnswer — gates (port of shouldInjectNonAnswer + RNG extremes)", () => {
  const base = (over: Partial<NonAnswerState> = {}): NonAnswerState => ({
    config: { enabled: true, probability: 1.0 },
    conversationHistory: history(["user", "hi"], ["assistant", "What is your order number?"]),
    isNodeSwitch: false,
    turnIndex: 2,
    lastTurnWasNonAnswer: false,
    lastTurnWasInterruption: false,
    ...over,
  });

  test("fires when all gates pass and rng=0", () => {
    expect(shouldInjectNonAnswer(base(), ZERO)).toBe(true);
  });

  test("does NOT fire at rng=1", () => {
    expect(shouldInjectNonAnswer(base(), ONE)).toBe(false);
  });

  test("does NOT fire at probability 0 (rng=0)", () => {
    expect(shouldInjectNonAnswer(base({ config: { enabled: true, probability: 0 } }), ZERO)).toBe(false);
  });

  test("disabled never injects", () => {
    expect(shouldInjectNonAnswer(base({ config: { enabled: false, probability: 1 } }), ZERO)).toBe(false);
  });

  test("turnIndex <= 1 never injects (needs a couple of turns first)", () => {
    expect(shouldInjectNonAnswer(base({ turnIndex: 1 }), ZERO)).toBe(false);
  });

  test("history shorter than 2 never injects", () => {
    expect(shouldInjectNonAnswer(base({ conversationHistory: history(["assistant", "What is your order number?"]) }), ZERO)).toBe(false);
  });

  test("node switch never injects", () => {
    expect(shouldInjectNonAnswer(base({ isNodeSwitch: true }), ZERO)).toBe(false);
  });

  test("not after a non-answer or an interruption", () => {
    expect(shouldInjectNonAnswer(base({ lastTurnWasNonAnswer: true }), ZERO)).toBe(false);
    expect(shouldInjectNonAnswer(base({ lastTurnWasInterruption: true }), ZERO)).toBe(false);
  });

  test("last message must be a non-blank assistant turn", () => {
    expect(shouldInjectNonAnswer(base({ conversationHistory: history(["assistant", "q?"], ["user", "answer here"]) }), ZERO)).toBe(false);
    expect(shouldInjectNonAnswer(base({ conversationHistory: history(["user", "hi"], ["assistant", "   "]) }), ZERO)).toBe(false);
  });
});

describe("pickNonAnswerType", () => {
  test("rng < 0.5 → presence_check; else topic_lock", () => {
    expect(pickNonAnswerType(() => 0)).toBe("presence_check");
    expect(pickNonAnswerType(() => 0.49)).toBe("presence_check");
    expect(pickNonAnswerType(() => 0.5)).toBe("topic_lock");
    expect(pickNonAnswerType(() => 0.99)).toBe("topic_lock");
  });
});

describe("interruptionRatio", () => {
  test("maps rng [0,1) to [0.3, 0.7)", () => {
    expect(interruptionRatio(() => 0)).toBeCloseTo(0.3, 10);
    expect(interruptionRatio(() => 0.5)).toBeCloseTo(0.5, 10);
    expect(interruptionRatio(() => 0.999)).toBeLessThan(0.7);
  });
});

describe("truncateMidSpeech — TTS-cancellation simulation (port of truncateMidSpeech)", () => {
  test("returns short text (<= 3 words) unchanged", () => {
    expect(truncateMidSpeech("Hi there", 0.5, ZERO)).toBe("Hi there");
    expect(truncateMidSpeech("Yes of course", 0.5, ZERO)).toBe("Yes of course");
  });

  test("truncates a long message to a visibly incomplete ending", () => {
    const text = "Your total is $437, and I've already applied the discount to your account for the next billing cycle";
    const result = truncateMidSpeech(text, 0.5, ZERO);
    expect(result).not.toBe(text);
    expect(result.length).toBeLessThan(text.length);
    const words = result.split(/\s+/);
    const last = words[words.length - 1];
    const isMidWord = !last.endsWith(".") && !last.endsWith("!") && !last.endsWith("?");
    expect(isMidWord || last.endsWith("--")).toBe(true);
  });

  test("low ratio truncates early", () => {
    const text = "I can help you with that. Let me check your account details and get back to you shortly";
    const result = truncateMidSpeech(text, 0.3, ZERO);
    expect(result).not.toBe(text);
    expect(result.split(/\s+/).length).toBeLessThanOrEqual(Math.ceil(text.split(/\s+/).length / 2));
  });

  test("deterministic under a fixed rng — clause boundary + advance + char cut", () => {
    // words: ["Sure,","let","me","look","that","up","for","you","right","now"] (10), ratio
    // 0.5 → targetIdx 5. "Sure," is a clause boundary at i=1 → boundaryIdx=1. rng=0 →
    // advance=1 → cutIdx=2. kept = words[0:2] = ["Sure,","let"]; the word AT cutIdx ("me", 2
    // runes ≤ 3) is rendered as "me--". Stable bytes.
    const text = "Sure, let me look that up for you right now";
    const result = truncateMidSpeech(text, 0.5, ZERO);
    expect(result).toBe("Sure, let me--");
  });

  test("no clause boundary → cuts at target index and trims a long last word", () => {
    // No comma/period/and before target. 7 words, ratio 0.5 → targetIdx=3 ("information").
    // rng=0 → cutChars=1 → keep first char of "information" → "i".
    const text = "please provide complete information regarding your matter";
    const result = truncateMidSpeech(text, 0.5, ZERO);
    expect(result).toBe("please provide complete i");
  });
});
