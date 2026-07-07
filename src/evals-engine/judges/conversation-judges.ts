// AO Eval Engine — conversation-axis judges (node-independent, whole-transcript).
//
// The node/goal judges score per-node behavior; voice conversations also carry
// CONVERSATION-level signals (voicemail / bot / call-screening / low-engagement /
// wrong-number / do-not-disturb / user-sentiment) plus a derived
// conversation_status. This module scores that axis from the full transcript.
//
// Design: 6 boolean detection judges + 1 sentiment classifier, all reading the full
// transcript once, run in parallel via the same `runLlmJudge` + strict-JSON path the
// node judges use. conversation_status is DERIVED in code from the detections
// (fixed priority: voicemail > bot > screening > low engagement), not an LLM call. Each judge is fault-tolerant: a
// failure defaults to "not detected" (a flaky supplementary signal must not blank the
// whole evaluation — unlike the node judges, whose failure is a hard eval_error).
//
// Criteria strings are verbatim from the SDK judges so behaviour matches the
// validated reference implementation.

import { z } from "zod";
import type { LlmProvider } from "../../llm/index.js";
import type { ConversationInput, SimConversationMetrics } from "../types.js";
import { runLlmJudge } from "./run-llm-judge.js";

// ── criteria bodies (verbatim from _instructions.py) ─────────────────────────
const VOICEMAIL = `Detect whether the conversation reached voicemail. This is a voice-channel classifier. Pass when the transcript is NOT voicemail. Fail when direct voicemail is detected.

Criteria:
1. Direct voicemail greetings, mailbox prompts, or leave-a-message flows mean voicemail_detected=true.
2. Call screening is NOT voicemail; classify screening separately even if it eventually asks for a message.
3. Bot/IVR menus are NOT voicemail.
4. Human conversation after an automated prompt means voicemail_detected=false.`;

const BOT = `Detect whether the answered party is an automated system or AI rather than a human. Pass when no bot/IVR/AI is present. Fail when bot_detected=true.

Criteria:
1. Menu prompts such as press 1, say billing, main menu, or repeat options are bot/IVR indicators.
2. Self-identification as an automated assistant, virtual assistant, AI assistant, or phone system is a bot indicator.
3. Voicemail and call screening are separate outcomes and should not be marked as bot_detected.
4. Analyze the answered party's messages, not the agent's own wording.
5. A conversational AI posing as the answered party is ALSO a bot. Strong signals (require at least one clear instance, not mere politeness): persistent assistant-register speech with reversed roles (the answered party repeatedly offers the agent help or asks what the agent needs, e.g. "I'm here to help with whatever you need", "What's the next step you'd like me to take?"); admitting to being an AI or language model when asked; or template-like responses that restate the agent's question instead of answering as a customer would. A fluent, cooperative human is NOT a bot — do not fire on eloquence alone.`;

const CALL_SCREENING = `Detect automated call screening where a system asks who is calling and why, and the real person does not subsequently answer. Pass when no unresolved call screening is present. Fail when call_screening=true.

Criteria:
1. iOS/Android/Google call screening asks for the caller's name, purpose, or reason for calling.
2. If the real person starts conversing after the screening prompt, screening was resolved and should not fail.
3. Screening followed by voicemail remains call_screening, not voicemail.
4. IVR menus with numbered routing options are bot/IVR, not call screening.`;

const LOW_ENGAGEMENT = `Detect low engagement: a real human answered but only gave minimal greetings or acknowledgements and never engaged with the topic. Pass when the user engaged meaningfully or the metric does not apply. Fail when low_engagement=true.

Criteria:
1. Applies after a human answered, not voicemail, call screening, or bot/IVR.
2. User messages are only brief greetings or acknowledgements such as hello, yes, yeah, speaking, okay.
3. Any substantive question, provided information, disinterest, wrong-number statement, or opt-out is not low engagement.`;

const WRONG_NUMBER = `Detect whether the user indicates they are not the intended recipient. Pass when wrong_number=false. Fail when wrong_number=true.

Criteria:
1. User says wrong number, wrong person, I do not know them, nobody by that name, or otherwise rejects the identity target.
2. General confusion about the purpose of the call is not enough.
3. Applies to voice, chat, SMS, and WhatsApp style transcripts.`;

const DO_NOT_DISTURB = `Detect whether the user explicitly asks not to be contacted again. Pass when do_not_disturb=false. Fail when do_not_disturb=true.

Criteria:
1. Explicit opt-out language such as do not call me again, remove me, stop contacting me, take me off your list, or similar means true.
2. Simple disinterest is not enough unless it includes a future-contact ban.
3. Applies to voice, chat, SMS, and WhatsApp style transcripts.`;

const USER_SENTIMENT = `Classify the user's sentiment as positive, neutral, negative, confused, or not_applicable. Pass unless the sentiment is clearly negative or confused in a way that indicates poor user experience; maybe for weak signals.

Rules:
1. positive: cooperative, receptive, appreciative.
2. neutral: minimal but valid engagement.
3. negative: dissatisfaction, rejection, hostility, frustration, opt-out.
4. confused: repeated uncertainty or requests for clarification.
5. not_applicable: no human interaction, voicemail, screening, or bot/IVR.`;

// Re-exported so the supervisor layer can show/critique the exact judge prompt
// when it suggests prompt fixes for a misflag.
export { VOICEMAIL, BOT, CALL_SCREENING, LOW_ENGAGEMENT, WRONG_NUMBER, DO_NOT_DISTURB, USER_SENTIMENT };

const OUT_DETECTION =
  '\n\nReturn ONLY a JSON object: {"detected": boolean, "reason": string, "technical_reason": string}. `reason` is a short human explanation; `technical_reason` is the internal rationale.';
const OUT_SENTIMENT =
  '\n\nReturn ONLY a JSON object: {"sentiment": "positive"|"neutral"|"negative"|"confused"|"not_applicable", "reason": string, "technical_reason": string}.';

// ── output schemas (strict JSON for the responses gateway) + Zod validation ──
type JsonSchema = Record<string, unknown>;
const strObj = (props: Record<string, unknown>): JsonSchema => ({
  type: "object",
  properties: props,
  required: Object.keys(props),
  additionalProperties: false,
});
const strict = (name: string, schema: JsonSchema) => ({ name, schema, strict: true });
const STR = { type: "string" } as const;
const BOOL = { type: "boolean" } as const;

// Sentiment is enum-constrained (strict JSON schema + Zod) so the model can't
// emit an off-enum value that the producer's pass rule and the console's
// fallback would classify differently — with only these five values, both
// reduce to the same result and the emitted user_sentiment.passed is the
// single source of truth.
const SENTIMENT_VALUES = ["positive", "neutral", "negative", "confused", "not_applicable"] as const;
const DETECTION_JSON = strict("eval_detection", strObj({ detected: BOOL, reason: STR, technical_reason: STR }));
const SENTIMENT_JSON = strict("eval_sentiment", strObj({ sentiment: { type: "string", enum: SENTIMENT_VALUES }, reason: STR, technical_reason: STR }));

const DetectionRawZ = z.object({ detected: z.boolean(), reason: z.string(), technical_reason: z.string() });
const SentimentRawZ = z.object({ sentiment: z.enum(SENTIMENT_VALUES), reason: z.string(), technical_reason: z.string() });

// ── judge execution ──────────────────────────────────────────────────────────
const DETECTION_MAX_TOKENS = 1500;

function payload(ctx: ConversationInput): Record<string, unknown> {
  // Detection judges classify what was SAID on the call, so prefer the
  // speech-only transcript when the builder provides one — internal evidence
  // lines (System_Note/Tool_Call/…) rendered as agent turns would let config
  // text (e.g. voicemail-handling guidance) masquerade as call reality.
  // `||` (not `??`): a transcript that is ALL evidence lines filters down to
  // "", and judging detections on an empty string would fabricate passes —
  // fall back to the full transcript in that case.
  return { flow_name: ctx.flow_name, conversation_history: ctx.speech_transcript || ctx.full_transcript };
}

/** Run one boolean detection judge; default to `detected:false` on any failure. */
async function runDetection(
  criteria: string,
  json: ReturnType<typeof strict>,
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ detected: boolean; reason: string; technical_reason: string; available: boolean }> {
  try {
    const { data } = await runLlmJudge({
      system: criteria + OUT_DETECTION,
      input: payload(ctx),
      schema: DetectionRawZ,
      jsonSchema: json,
      maxTokens: DETECTION_MAX_TOKENS,
      provider,
    });
    return { ...data, available: true };
  } catch {
    return { detected: false, reason: "", technical_reason: "conversation judge unavailable", available: false };
  }
}

async function runSentiment(
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ sentiment: string; reason: string; technical_reason: string; available: boolean }> {
  try {
    const { data } = await runLlmJudge({
      system: USER_SENTIMENT + OUT_SENTIMENT,
      input: payload(ctx),
      schema: SentimentRawZ,
      jsonSchema: SENTIMENT_JSON,
      maxTokens: DETECTION_MAX_TOKENS,
      provider,
    });
    return { ...data, available: true };
  } catch {
    return { sentiment: "", reason: "", technical_reason: "sentiment judge unavailable", available: false };
  }
}

/** The single source of truth for the sentiment pass/fail rule: a sentiment
 *  fails only when it is clearly negative or confused. Fan-out, config-service,
 *  and the console read the emitted `passed` rather than re-implementing this. */
export function sentimentPassed(sentiment: string): boolean {
  return !/negativ|confus/i.test(sentiment);
}

/** True if the transcript has any non-empty user utterance. */
function isAnswered(ctx: ConversationInput): boolean {
  return /(^|\n)User:\s*\S/.test(ctx.full_transcript);
}

const det = (v: { detected: boolean; reason: string; technical_reason: string; available?: boolean }) => ({
  detected: v.detected,
  detected_value: v.detected ? 1 : 0,
  reason: v.reason,
  technical_reason: v.technical_reason,
  available: v.available !== false,
});

/**
 * Score the conversation axis over the full transcript and return real
 * `conversation_metrics` (SimConversationMetrics). All six detections + sentiment
 * run on every transcript (there is no channel field to gate on).
 * `conversation_status` is derived in code (fixed priority order).
 */
/** All-zero conversation metrics with every axis marked unavailable — the
 *  placeholder for an empty transcript (ingest) or a skipped conversation eval
 *  (sim). `available:false` is how consumers tell "the judge did not run" from
 *  a real "not detected" verdict, so these are never fanned out as passes. */
export function zeroConversationMetrics(): SimConversationMetrics {
  const d = () => ({ detected: false, detected_value: 0, reason: "", technical_reason: "", available: false });
  return {
    answered: false,
    voicemail_detected: d(), bot_detected: d(), call_screening: d(),
    low_engagement: d(), wrong_number: d(), do_not_disturb: d(),
    user_sentiment: { sentiment: "", reason: "", technical_reason: "", available: false },
    silent_call: false,
    customer_engaged: false,
    conversation_status: { status: "", reason: "", technical_reason: "" },
    is_livekit: false,
    is_agent_runner: false,
    stt: { error_count: 0, recovered_count: 0 },
  };
}

export async function evaluateConversationMetrics(
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<SimConversationMetrics> {
  const answered = isAnswered(ctx);

  const [voicemail, bot, screening, lowEng, wrong, dnd, sentiment] = await Promise.all([
    runDetection(VOICEMAIL, DETECTION_JSON, ctx, provider),
    runDetection(BOT, DETECTION_JSON, ctx, provider),
    runDetection(CALL_SCREENING, DETECTION_JSON, ctx, provider),
    runDetection(LOW_ENGAGEMENT, DETECTION_JSON, ctx, provider),
    runDetection(WRONG_NUMBER, DETECTION_JSON, ctx, provider),
    runDetection(DO_NOT_DISTURB, DETECTION_JSON, ctx, provider),
    runSentiment(ctx, provider),
  ]);

  // Fixed priority order for the final status label.
  let status = "answered";
  if (!answered) status = "unanswered";
  else if (voicemail.detected) status = "voicemail_detected";
  else if (bot.detected) status = "bot_detected";
  else if (screening.detected) status = "call_screening";
  else if (lowEng.detected) status = "low_engagement";
  const customerEngaged = answered && !lowEng.detected;

  return {
    answered,
    voicemail_detected: det(voicemail),
    bot_detected: det(bot),
    call_screening: det(screening),
    low_engagement: det(lowEng),
    wrong_number: det(wrong),
    do_not_disturb: det(dnd),
    user_sentiment: {
      sentiment: sentiment.sentiment || "unknown",
      reason: sentiment.reason,
      technical_reason: sentiment.technical_reason,
      available: sentiment.available,
      passed: sentiment.available ? sentimentPassed(sentiment.sentiment) : undefined,
    },
    silent_call: !answered,
    customer_engaged: customerEngaged,
    conversation_status: { status, reason: "", technical_reason: "" },
    // Platform-neutral: the ingest path makes no runtime claim (was hardcoded
    // true here and overridden to false by the only caller).
    is_livekit: false,
    is_agent_runner: false,
    stt: { error_count: 0, recovered_count: 0 },
  };
}
