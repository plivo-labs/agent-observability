// AO Eval Engine — conversation-axis judges (the "Phase 2" live axis, node-independent).
//
// The engine's Phase 1 scores node + goal only; cx-sqs also emits CONVERSATION-level
// signals (voicemail / bot / call-screening / low-engagement / wrong-number /
// do-not-disturb / user-sentiment) + a derived conversation_status. This module ports
// those judges to TS so the cx-redirect (live) path returns real conversation_metrics
// instead of the all-default block.
//
// Design: 6 boolean detection judges + 1 sentiment classifier, all reading the full
// transcript once, run in parallel via the same `runLlmJudge` + strict-JSON path the
// node judges use. conversation_status is DERIVED in code from the detections
// (cx-sqs priority order), not a separate LLM call. Each judge is fault-tolerant: a
// failure defaults to "not detected" (a flaky supplementary signal must not blank the
// whole evaluation — unlike the node judges, whose failure is a hard eval_error).
//
// Criteria strings are verbatim from the SDK (_instructions.py) so behaviour matches
// the validated Python judges.

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

const BOT = `Detect whether the call was answered by an automated IVR/bot system rather than a human. Pass when no bot/IVR is present. Fail when bot_detected=true.

Criteria:
1. Menu prompts such as press 1, say billing, main menu, or repeat options are bot/IVR indicators.
2. Self-identification as an automated assistant, virtual assistant, AI assistant, or phone system is a bot indicator.
3. Voicemail and call screening are separate outcomes and should not be marked as bot_detected.
4. Analyze the answered party's messages, not the agent's own wording.`;

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

const DETECTION_JSON = strict("eval_detection", strObj({ detected: BOOL, reason: STR, technical_reason: STR }));
const SENTIMENT_JSON = strict("eval_sentiment", strObj({ sentiment: STR, reason: STR, technical_reason: STR }));

const DetectionRawZ = z.object({ detected: z.boolean(), reason: z.string(), technical_reason: z.string() });
const SentimentRawZ = z.object({ sentiment: z.string(), reason: z.string(), technical_reason: z.string() });

// ── judge execution ──────────────────────────────────────────────────────────
const DETECTION_MAX_TOKENS = 1500;

function payload(ctx: ConversationInput): Record<string, unknown> {
  return { flow_name: ctx.flow_name, conversation_history: ctx.full_transcript };
}

/** Run one boolean detection judge; default to `detected:false` on any failure. */
async function runDetection(
  criteria: string,
  json: ReturnType<typeof strict>,
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ detected: boolean; reason: string; technical_reason: string }> {
  try {
    const { data } = await runLlmJudge({
      system: criteria + OUT_DETECTION,
      input: payload(ctx),
      schema: DetectionRawZ,
      jsonSchema: json,
      maxTokens: DETECTION_MAX_TOKENS,
      provider,
    });
    return data;
  } catch {
    return { detected: false, reason: "", technical_reason: "conversation judge unavailable" };
  }
}

async function runSentiment(
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ sentiment: string; reason: string; technical_reason: string }> {
  try {
    const { data } = await runLlmJudge({
      system: USER_SENTIMENT + OUT_SENTIMENT,
      input: payload(ctx),
      schema: SentimentRawZ,
      jsonSchema: SENTIMENT_JSON,
      maxTokens: DETECTION_MAX_TOKENS,
      provider,
    });
    return data;
  } catch {
    return { sentiment: "", reason: "", technical_reason: "sentiment judge unavailable" };
  }
}

/** True if the transcript has any non-empty user utterance (mirror cx-sqs checkAnswered). */
function isAnswered(ctx: ConversationInput): boolean {
  return /(^|\n)User:\s*\S/.test(ctx.full_transcript);
}

const det = (v: { detected: boolean; reason: string; technical_reason: string }) => ({
  detected: v.detected,
  detected_value: v.detected ? 1 : 0,
  reason: v.reason,
  technical_reason: v.technical_reason,
});

/**
 * Score the conversation axis over the full transcript and return real
 * `conversation_metrics` (SimConversationMetrics). Only voice-relevant detections
 * (voicemail / bot / call-screening) are gated to voice; the rest apply cross-channel.
 * `conversation_status` is derived in code (cx-sqs priority order).
 */
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

  // cx-sqs priority order for the final status label.
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
    cx_voicemail_detected: 0,
    cx_call_screening_detected: 0,
    bot_detected: det(bot),
    call_screening: det(screening),
    low_engagement: det(lowEng),
    wrong_number: det(wrong),
    do_not_disturb: det(dnd),
    user_sentiment: {
      sentiment: sentiment.sentiment || "unknown",
      reason: sentiment.reason,
      technical_reason: sentiment.technical_reason,
    },
    silent_call: !answered,
    customer_engaged: customerEngaged,
    conversation_status: { status, reason: "", technical_reason: "" },
    is_livekit: true,
    is_agent_runner: false,
    stt: { error_count: 0, recovered_count: 0 },
  };
}
