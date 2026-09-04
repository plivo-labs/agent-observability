// AO Eval Engine — conversation-axis judges (node-independent, whole-transcript).
//
// The node/goal judges score per-node behavior; voice conversations also carry
// CONVERSATION-level signals (voicemail / bot / call-screening / low-engagement /
// wrong-number / do-not-disturb / user-sentiment / STT) plus a derived
// conversation_status. This module scores that axis from the full transcript.
//
// Design: 6 boolean detection judges + 1 sentiment classifier + 1 STT judge, all
// reading the transcript once, run in parallel via the same `runLlmJudge` +
// strict-JSON path the node judges use. Fault tolerance is split by error
// durability: a DETERMINISTIC failure (schema/content policy) defaults to
// "not detected / unavailable" (a flaky supplementary signal must not blank the
// whole evaluation), while a TRANSIENT provider failure (timeout/429/5xx)
// rethrows so the whole session retries — same as the node judges — instead of
// silently completing 'done' with that verdict permanently dropped.
//
// CALIBRATION (ported from cx-sqs conversation/system.tmpl):
//   - Voice-only detections (voicemail / bot / call-screening / STT) are GATED on
//     the transport: on text channels (chat/SMS/WhatsApp) they don't run, so they
//     can't false-positive on a text transcript.
//   - MUTUAL EXCLUSIVITY is enforced on the EMITTED booleans (not just the derived
//     status): voicemail/screening suppress bot + low-engagement; otherwise the
//     priority bot > wrong_number > do_not_disturb > low_engagement resolves
//     conflicts. This stops two outcomes co-firing into alerts.
//   - conversation_status is derived in code from the finalized booleans.

import { z } from "zod";
import type { LlmProvider } from "../../llm/index.js";
import type { ConversationInput, SimConversationMetrics } from "../types.js";
import { classifyErrorDurability } from "../../error-durability.js";
import { runLlmJudge, type RunLlmJudgeArgs } from "./run-llm-judge.js";
import { DETECTION_JSON, SENTIMENT_JSON, SENTIMENT_VALUES, STT_JSON, TRANSFER_CONSENT_JSON, TRANSFER_CONSENT_REASON_CODES, type TransferConsentReasonCode } from "./schemas.js";

// ── criteria bodies ──────────────────────────────────────────────────────────
export const VOICEMAIL = `Detect whether the conversation reached voicemail. This is a voice-channel classifier. Pass when the transcript is NOT voicemail. Fail when direct voicemail is detected.

Criteria:
1. Direct voicemail greetings, mailbox prompts, or leave-a-message flows mean voicemail_detected=true.
2. Call screening is NOT voicemail; classify screening separately even if it eventually asks for a message.
3. Bot/IVR menus are NOT voicemail.
4. Human conversation after an automated prompt means voicemail_detected=false.`;

export const BOT = `Detect whether the COUNTERPARTY is an automated system or AI rather than a human. Pass when no bot/IVR/AI is present. Fail when bot_detected=true.

WHO IS JUDGED: the transcript labels our own AI under test as "Agent:" — it is an automated assistant BY DEFINITION and is NEVER evidence for this metric. Judge ONLY the "User:" lines (the other party on the call). The Agent's self-identification ("I'm a virtual assistant…"), scripted greetings, menu-like offers of help, capability lists, idle re-prompts ("Are you still there?"), and scripted disconnect lines are its normal operation — citing ANY Agent: line as bot evidence is an automatic error.

Criteria (all applied to User: lines only):
1. Menu prompts such as press 1, say billing, main menu, or repeat options are bot/IVR indicators.
2. Self-identification as an automated assistant, virtual assistant, AI assistant, or phone system is a bot indicator.
3. Voicemail and call screening are separate outcomes and should not be marked as bot_detected.
4. A conversational AI posing as the counterparty is ALSO a bot. Strong signals (require at least one clear instance, not mere politeness): persistent assistant-register speech with reversed roles (the counterparty repeatedly offers the agent help or asks what the agent needs, e.g. "I'm here to help with whatever you need", "What's the next step you'd like me to take?"); admitting to being an AI or language model when asked; or template-like responses that restate the agent's question instead of answering as a customer would. A fluent, cooperative human is NOT a bot — do not fire on eloquence alone.
5. A human asking OUR agent whether IT is a robot/real person is a suspicious human, not a bot — that is evidence the counterparty is human.`;

export const CALL_SCREENING = `Detect automated call screening where a system asks who is calling and why, and the real person does not subsequently answer. Pass when no unresolved call screening is present. Fail when call_screening=true.

Criteria:
1. iOS/Android/Google call screening asks for the caller's name, purpose, or reason for calling.
2. If the real person starts conversing after the screening prompt, screening was resolved and should not fail.
3. Screening followed by voicemail remains call_screening, not voicemail.
4. IVR menus with numbered routing options are bot/IVR, not call screening.`;

export const LOW_ENGAGEMENT = `Detect low engagement: a real human answered but only gave minimal greetings or acknowledgements and never engaged with the topic. Pass when the user engaged meaningfully or the metric does not apply. Fail when low_engagement=true.

Criteria:
1. Applies after a human answered, not voicemail, call screening, or bot/IVR.
2. User messages are only brief greetings or acknowledgements such as hello, yes, yeah, speaking, okay.
3. Any substantive question, provided information, disinterest, wrong-number statement, or opt-out is not low engagement.
4. Repeated connection checks ("hello?", "can you hear me?") with no response to the agent's purpose are low engagement, not confusion.`;

export const WRONG_NUMBER = `Detect whether the user indicates they are not the intended recipient. Pass when wrong_number=false. Fail when wrong_number=true.

Criteria:
1. Only flag AFTER the agent has introduced itself or explained the purpose — an initial "who is this?" / "hello?" alone is normal, not a wrong number.
2. User says wrong number, wrong person, I do not know them, nobody by that name, denies the identity, or says they never signed up / have no account after the explanation.
3. General confusion about the purpose of the call, or simply declining while acknowledging they are the right person, is not enough (that is do_not_disturb or negative sentiment).
4. Applies to voice, chat, SMS, and WhatsApp style transcripts.`;

export const DO_NOT_DISTURB = `Detect whether the user explicitly asks not to be contacted again. Pass when do_not_disturb=false. Fail when do_not_disturb=true.

Criteria:
1. Explicit opt-out language such as do not call me again, remove me, stop contacting me, take me off your list, unsubscribe, or similar means true.
2. Simple disinterest ("not interested", "no thanks") is NOT enough unless it includes a future-contact ban.
3. Asking to be contacted later ("call me back later", "not a good time") is rescheduling, not do_not_disturb.
4. Applies to voice, chat, SMS, and WhatsApp style transcripts.`;

export const USER_SENTIMENT = `Classify the user's sentiment as positive, neutral, negative, confused, or not_applicable — the user's predominant emotional state, leaning on the closing tone. Pass unless the sentiment is clearly negative or confused; maybe for weak signals.

Rules:
1. positive: cooperative, receptive, appreciative, agrees or provides requested information. A user who cooperates throughout is positive EVEN IF their final message is a follow-up question about next steps — a follow-up question is not negative. Declining an offered action is positive unless they express dissatisfaction with the service itself.
2. neutral: minimal but valid engagement — a single greeting or brief factual reply with no emotional signal, or a conversation too short to judge.
3. negative: expressed dissatisfaction, hostility, frustration, complaints, opt-out, or deflection ("send me details" / "WhatsApp me") with no follow-up acceptance. Negative requires an EMOTIONAL signal or explicit dissatisfaction with the service — a calm decline of an offer ("No", "No thanks"), a polite factual correction (e.g. "I think you have the wrong number"), or a brief refusal to proceed WITHOUT complaint language is neutral, not negative. Brevity is not calm: a curt refusal that carries hostility or irritation ("No. Stop calling me.") is still negative.
4. confused: REPEATED uncertainty or clarification requests across MULTIPLE user turns. A single message followed by silence is NOT confused — it is neutral.
5. not_applicable: no human interaction — voicemail, call screening, or bot/IVR answered. When a detection outcome (voicemail/screening/bot) is present, sentiment is not_applicable.`;

export const STT = `Evaluate speech-to-text quality across the conversation. For each USER turn, decide whether the transcription shows an STT error, then whether the agent recovered. Output aggregate counts only.

Flag an STT error ONLY in these four categories:
1. Garbled/nonsensical — not coherent language in any language the speaker used.
2. Out-of-context (misheard) — real words clearly wrong for what was asked, or a phonetic mishearing the user then corrects.
3. Random language switch — a sudden, unexplained switch to a different language for a single turn.
4. Truncated mid-sentence — cut off mid-clause so meaning is lost (NOT brief-but-complete replies like "Yes"/"Okay").

NOT STT errors: short valid replies, informal/colloquial speech, the user simply saying something unexpected but plausible, or coherent multilingual speech.

Recovery: an error is RECOVERED when the agent moved the conversation forward on the likely intended meaning AND the user did not correct it or repeat themselves. Otherwise it FAILED (agent acted on the wrong literal words, asked the user to repeat, or the user corrected/restated).

Rules: evaluate every user turn; at most one error per turn; recovered_count must be <= error_count; do not flag a brief opening greeting.

Default bias: CONSERVATIVE — when unsure whether a turn is an STT error or genuine user speech, do NOT flag it; when unsure about recovery, count it as not recovered.`;

export const TRANSFER_CONSENT = `Judge whether the caller gave clear, unambiguous consent to the transfer before the platform transferred them to a human. This judge runs ONLY on calls where a transfer was executed — a platform-confirmed fact, supplied as transfer_intent. Pass (consent_given=true) when the caller clearly agreed to be transferred. Fail (consent_given=false) when the transfer executed without that agreement.

WHO IS JUDGED: "Agent:" lines are our AI; "User:" lines are the caller. Consent must come from a User: line. An Agent: line announcing or assuming the transfer is not consent.

Criteria:
1. Consent = an explicit affirmative reply from the caller to a transfer offer ("yes", "sure, go ahead", "okay, connect me"), or the caller's own unprompted request to be connected ("can I talk to someone?"). It must come AFTER the agent offered or explained the transfer, or be the caller's own request.
2. reason_code "declined": the caller said no, not interested, stop calling, or otherwise refused the transfer — and the transfer executed anyway.
3. reason_code "busy": the caller said they were busy, could not talk now, or asked to be called back — and the transfer executed anyway.
4. reason_code "mid_sentence": the caller was still speaking, or had only started answering a different question, with no completed affirmative — when the transfer executed.
5. reason_code "hold_music": the User: lines are only hold music, an IVR, ringing, or non-conversational audio artefacts — no real person answered — yet the transfer executed.
6. reason_code "no_caller": the User: lines carry nothing substantive at all (empty, silence markers, background noise) — nobody was on the line.
7. reason_code "ok": consent was given. reason_code MUST be "ok" whenever consent_given is true.
8. transfer_node_instructions are the flow's own definition of when to transfer (e.g. a configured "Transfer Approved" intent). Read them for context, but the caller's actual words decide: an intent name or the agent's belief is NOT consent.
9. Ambiguous fragments ("hmm", "uh", "hello?", "what?") are NOT consent. A clear affirmative is. Do not fail a transfer for brevity when the affirmative is unambiguous ("yes" is enough).`;

export const OUT_DETECTION =
  '\n\nReturn ONLY a JSON object: {"detected": boolean, "reason": string, "technical_reason": string}. `reason` is a short human explanation; `technical_reason` is the internal rationale.';
export const OUT_SENTIMENT =
  '\n\nReturn ONLY a JSON object: {"sentiment": "positive"|"neutral"|"negative"|"confused"|"not_applicable", "reason": string, "technical_reason": string}.';
export const OUT_STT =
  '\n\nReturn ONLY a JSON object: {"error_count": integer (>=0), "recovered_count": integer (0..error_count), "reason": string, "technical_reason": string}.';
export const OUT_TRANSFER_CONSENT =
  '\n\nReturn ONLY a JSON object: {"consent_given": boolean, "reason_code": "ok"|"declined"|"busy"|"mid_sentence"|"hold_music"|"no_caller", "reason": string, "technical_reason": string}. reason_code MUST be "ok" when consent_given is true.';

// ── Zod validation (the strict JSON schemas live in schemas.ts with the node/goal ones) ──
const DetectionRawZ = z.object({ detected: z.boolean(), reason: z.string(), technical_reason: z.string() });
const SentimentRawZ = z.object({ sentiment: z.enum(SENTIMENT_VALUES), reason: z.string(), technical_reason: z.string() });
const SttRawZ = z.object({ error_count: z.number(), recovered_count: z.number(), reason: z.string(), technical_reason: z.string() });
const TransferConsentRawZ = z.object({
  consent_given: z.boolean(),
  reason_code: z.enum(TRANSFER_CONSENT_REASON_CODES),
  reason: z.string(),
  technical_reason: z.string(),
});

// ── judge execution ──────────────────────────────────────────────────────────
const DETECTION_MAX_TOKENS = 1500;
const STT_MAX_TOKENS = 3000;

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

export type DetectionResult = { detected: boolean; reason: string; technical_reason: string; available: boolean };

/** A voice-only detection that did not run on this (non-voice) channel. Marked
 *  unavailable so fan-out skips it — never emitted as a real pass/fail. */
const skippedDetection = (why: string): DetectionResult => ({ detected: false, reason: "", technical_reason: why, available: false });

type SttResult = { error_count: number; recovered_count: number; available: boolean };

/** STT metrics for a run where the STT judge did not execute (non-voice channel
 *  or a failed judge call). `available:false` so fan-out skips it — same pattern
 *  as skippedDetection, keeping the skipped shape in one place. */
const skippedStt = (): SttResult => ({ error_count: 0, recovered_count: 0, available: false });

/** One skeleton for every conversation judge: run the LLM call over the
 *  transcript payload, transform the validated output, and on a DETERMINISTIC
 *  failure (schema/content policy — identical on retry) return the judge's
 *  unavailable-shaped fallback. The module invariant ("a flaky supplementary
 *  signal must not blank the whole evaluation") lives here, once — not
 *  copy-pasted per judge.
 *
 *  TRANSIENT failures (timeout/429/5xx/network) RETHROW instead: swallowing
 *  them would permanently drop that verdict while the session still completes
 *  'done' — a provider burst mid-judging must retry the session (the thrown
 *  error reaches judgeClaimed, which keeps the claim running for stale
 *  adoption), matching the node judges' behavior. */
async function safeJudge<T, R>(
  call: {
    system: string;
    ctx: ConversationInput;
    /** Payload override for a judge that needs more than the transcript
     *  (default: `payload(ctx)`). */
    input?: unknown;
    schema: z.ZodType<T>;
    jsonSchema: RunLlmJudgeArgs<T>["jsonSchema"];
    maxTokens: number;
    provider?: LlmProvider;
  },
  transform: (data: T) => R,
  fallback: R,
): Promise<R> {
  try {
    const { data } = await runLlmJudge({
      system: call.system,
      input: call.input ?? payload(call.ctx),
      schema: call.schema,
      jsonSchema: call.jsonSchema,
      maxTokens: call.maxTokens,
      provider: call.provider,
    });
    return transform(data);
  } catch (e) {
    if (classifyErrorDurability(e) === "transient") throw e;
    return fallback;
  }
}

/** Run one boolean detection judge; default to `detected:false` on any failure. */
function runDetection(criteria: string, ctx: ConversationInput, provider?: LlmProvider): Promise<DetectionResult> {
  return safeJudge(
    { system: criteria + OUT_DETECTION, ctx, schema: DetectionRawZ, jsonSchema: DETECTION_JSON, maxTokens: DETECTION_MAX_TOKENS, provider },
    (data): DetectionResult => ({ ...data, available: true }),
    { detected: false, reason: "", technical_reason: "conversation judge unavailable", available: false },
  );
}

type SentimentResult = { sentiment: string; reason: string; technical_reason: string; available: boolean };

function runSentiment(ctx: ConversationInput, provider?: LlmProvider): Promise<SentimentResult> {
  return safeJudge(
    { system: USER_SENTIMENT + OUT_SENTIMENT, ctx, schema: SentimentRawZ, jsonSchema: SENTIMENT_JSON, maxTokens: DETECTION_MAX_TOKENS, provider },
    (data): SentimentResult => ({ ...data, available: true }),
    { sentiment: "", reason: "", technical_reason: "sentiment judge unavailable", available: false },
  );
}

/** STT quality over the transcript. Voice-only; caller passes a skipped result on
 *  text channels. Fault-tolerant: any failure → unavailable (never a fabricated 0). */
function runStt(ctx: ConversationInput, provider?: LlmProvider): Promise<SttResult> {
  return safeJudge(
    { system: STT + OUT_STT, ctx, schema: SttRawZ, jsonSchema: STT_JSON, maxTokens: STT_MAX_TOKENS, provider },
    (data): SttResult => {
      const errors = Math.max(0, Math.round(data.error_count));
      // Clamp recovered into [0, errors] — the constraint the prompt states, enforced.
      const recovered = Math.min(errors, Math.max(0, Math.round(data.recovered_count)));
      return { error_count: errors, recovered_count: recovered, available: true };
    },
    skippedStt(),
  );
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

/** Voice unless the transport is clearly a text channel. Unknown transport ⇒
 *  voice (the historical default: every ingested session was a voice call). */
const TEXT_CHANNEL_RE = /chat|sms|whatsapp|messenger|web|text|email|rcs/i;
function isVoiceChannel(transport?: string): boolean {
  return !transport || !TEXT_CHANNEL_RE.test(transport);
}

const det = (v: DetectionResult) => ({
  detected: v.detected,
  detected_value: v.detected ? 1 : 0,
  reason: v.reason,
  technical_reason: v.technical_reason,
  available: v.available !== false,
});

/** Build a code-derived detection in the same raw shape as an LLM verdict so
 * every final outcome can flow through the same det()/suppressed() emission. */
const derivedDetection = (reason: string, technicalReason: string): DetectionResult => ({
  detected: true,
  reason,
  technical_reason: technicalReason,
  available: true,
});

/** Emit a detection whose raw verdict was overruled by mutual exclusivity. Keeps
 *  `available:true` (the judge ran) but reports not-detected, so it fans out as a
 *  clean "not this outcome" rather than co-firing with the winner. */
const suppressed = (raw: DetectionResult) =>
  raw.detected
    ? { detected: false, detected_value: 0, reason: "", technical_reason: "superseded by a higher-priority conversation outcome", available: true }
    : det(raw);

/**
 * USER NEVER SPOKE — the caller produced no turn at all.
 *
 * Transcript-only, decided in CODE: a `User:` line with content means the user
 * spoke. Channel-agnostic — unlike voicemail/bot this is not a telephony
 * concept, so it is NOT gated on the transport. An empty transcript is
 * undecidable (no data to read), which is unavailable — NOT a clean "the user
 * spoke". That honours the availability contract: an unavailable axis fans out
 * as nothing, never as a pass.
 *
 * Distinct from `silent_call` (a boolean gated on the agent having asked a
 * question): this is the plain "zero user turns" signal, emitted as its own axis.
 */
export function evaluateUserNeverSpoke(ctx: ConversationInput): DetectionResult {
  const transcript = ctx.full_transcript ?? "";
  if (!transcript.trim()) {
    return skippedDetection("empty transcript — user_never_spoke undecidable");
  }
  if (isAnswered(ctx)) {
    return { detected: false, reason: "", technical_reason: "at least one user turn present", available: true };
  }
  return derivedDetection(
    "The user never spoke on this call — no user turn was recorded.",
    "derived in code: zero user turns in the judged transcript (no `User:` line with content)",
  );
}

/** The session tag the platform attaches when a transfer to a human EXECUTED
 *  (runtime-confirmed). Its `metadata.intent` is the handoff intent that fired. */
export const TRANSFER_TAG = "transfer:human";

export type TransferConsentResult = DetectionResult & { reason_code: TransferConsentReasonCode | "" };

/**
 * HUMAN TRANSFER — the transfer FACT, decided in CODE from the session tags.
 *
 * `detected` means a transfer to a human executed, as asserted by the ingest
 * client through the `transfer:human` tag. AO cannot verify the assertion; the
 * trust boundary is the same one the whole transcript crosses (an authenticated
 * ingest client), and the platform runtime emits the tag only from its own
 * confirmed transfer branch. Nothing is inferred from the transcript: a "let me
 * transfer you" line is not a transfer.
 *
 * ABSENCE IS NOT EVIDENCE. Without the tag the axis is unavailable — never a
 * "not transferred" pass: senders that predate the tag (older runtime builds,
 * other SDKs, the sim path) emit nothing, and a pass row there would be a
 * confident falsehood written permanently into a done session. So this judge
 * only ever asserts the fact; "not transferred" is the judged sessions that
 * carry no row, and consumers count transfers as its fail rows.
 */
export function evaluateHumanTransfer(ctx: ConversationInput): DetectionResult {
  const intent = transferIntent(ctx);
  if (intent === null) {
    return skippedDetection("no transfer:human tag on the session — absence is not evidence of no transfer");
  }
  const nextNode = transferNextNode(ctx);
  const where = nextNode ? ` → ${nextNode}` : "";
  return derivedDetection(
    intent ? `A transfer to a human was executed (intent: ${intent}${where}).` : `A transfer to a human was executed${where ? ` (${where.trim()})` : ""}.`,
    "derived in code: session tag transfer:human (the ingest client's transfer confirmation)",
  );
}

/** The flow node the platform handed the call to, when the tag carries it —
 *  lets a handback that was NOT to a human be audited downstream. */
function transferNextNode(ctx: ConversationInput): string {
  const tag = ctx.tags?.find((t) => t && t.name === TRANSFER_TAG);
  const next = tag?.metadata?.next_node;
  return typeof next === "string" ? next.trim().slice(0, 200) : "";
}

/** The handoff intent carried by the transfer tag: `null` when the session has
 *  no `transfer:human` tag, `""` when the tag carries no usable intent. */
function transferIntent(ctx: ConversationInput): string | null {
  const tag = ctx.tags?.find((t) => t && t.name === TRANSFER_TAG);
  if (!tag) return null;
  const intent = tag.metadata?.intent;
  return typeof intent === "string" ? intent.trim().slice(0, 200) : "";
}

/** The node whose instructions define the transfer: the one that OWNS the
 *  handoff intent (matched by intent name in its available_intents), else the
 *  last node visited — the transfer is terminal by construction, so on the
 *  live path that is the transferring node; the intent match protects the
 *  case where a later node still ran (a revisit, a wrap-up hop). */
function transferringNode(ctx: ConversationInput, intent: string): ConversationInput["nodes"][number] | undefined {
  if (intent) {
    const owner = ctx.nodes.find((n) =>
      (n.available_intents ?? []).some((i) => {
        const name = (i as { intent_name?: unknown } | null)?.intent_name;
        return typeof name === "string" && name === intent;
      }),
    );
    if (owner) return owner;
  }
  return ctx.nodes[ctx.nodes.length - 1];
}

/** The consent judge reads the speech transcript plus two facts the plain
 *  detection payload lacks: WHICH intent transferred, and the transferring
 *  node's own instructions. */
function transferPayload(ctx: ConversationInput): Record<string, unknown> {
  const intent = transferIntent(ctx) ?? "";
  return {
    ...payload(ctx),
    transfer_intent: intent,
    transfer_node_instructions: transferringNode(ctx, intent)?.node_prompt ?? "",
  };
}

/**
 * TRANSFER CONSENT — the transfer JUDGEMENT. Gated on the fact: no transfer ⇒
 * not applicable (unavailable, fans out nothing). A transferred call where the
 * caller never spoke needs no LLM to grade — nobody consented because nobody
 * was there — so it short-circuits in code to `no_caller`. Everything else is
 * the LLM judge over the transcript up to the transfer.
 */
async function resolveTransferConsent(
  ctx: ConversationInput,
  humanTransfer: DetectionResult,
  userNeverSpoke: DetectionResult,
  provider?: LlmProvider,
): Promise<TransferConsentResult> {
  if (!humanTransfer.available || !humanTransfer.detected) {
    return { ...skippedDetection("no human transfer on this session — consent not applicable"), reason_code: "" };
  }
  if (userNeverSpoke.available && userNeverSpoke.detected) {
    return {
      detected: true,
      reason: "The caller never spoke — the transfer executed with nobody on the line.",
      technical_reason: "derived in code: user_never_spoke fired on a transferred session (no LLM call)",
      available: true,
      reason_code: "no_caller",
    };
  }
  return safeJudge(
    {
      system: TRANSFER_CONSENT + OUT_TRANSFER_CONSENT,
      ctx,
      input: transferPayload(ctx),
      schema: TransferConsentRawZ,
      jsonSchema: TRANSFER_CONSENT_JSON,
      maxTokens: DETECTION_MAX_TOKENS,
      provider,
    },
    (data): TransferConsentResult => {
      // The prompt pins the code to the verdict both ways: consent ⇒ "ok", and
      // a fail must name a defect. A fail carrying "ok" is a contradictory
      // verdict — stored, it would corrupt every reason-code rollup — so it is
      // treated like any other invalid output: unavailable, never fabricated.
      if (!data.consent_given && data.reason_code === "ok") {
        return { ...skippedDetection("consent judge returned fail with reason_code ok — invalid verdict"), reason_code: "" };
      }
      return {
        detected: !data.consent_given,
        reason: data.reason,
        technical_reason: data.technical_reason,
        available: true,
        reason_code: data.consent_given ? "ok" : data.reason_code,
      };
    },
    { ...skippedDetection("transfer consent judge unavailable"), reason_code: "" },
  );
}

/** The FACT alone, in the stored CmDetection shape — for the path where no
 *  transcript exists to judge (the fact needs none) and consent must stay
 *  unavailable rather than be fabricated from nothing. */
export function evaluateHumanTransferMetric(ctx: ConversationInput): SimConversationMetrics["human_transfer"] {
  return det(evaluateHumanTransfer(ctx));
}

/** The whole transfer axis in one call: the code-derived FACT plus the gated
 *  consent JUDGEMENT, emitted in the stored CmDetection shape. Shared by the
 *  live evaluation (evaluateConversationMetrics) and the backfill re-judge
 *  (transfer-rejudge.ts), so both paths can never disagree on the rule. */
export async function evaluateTransferAxis(
  ctx: ConversationInput,
  userNeverSpoke: DetectionResult,
  provider?: LlmProvider,
): Promise<Pick<SimConversationMetrics, "human_transfer" | "transfer_consent">> {
  const humanTransfer = evaluateHumanTransfer(ctx);
  const transferConsent = await resolveTransferConsent(ctx, humanTransfer, userNeverSpoke, provider);
  return {
    human_transfer: det(humanTransfer),
    transfer_consent: { ...det(transferConsent), reason_code: transferConsent.reason_code },
  };
}

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
    stt: skippedStt(),
    user_never_spoke: d(),
    human_transfer: d(),
    transfer_consent: { ...d(), reason_code: "" },
  };
}

export interface ConversationDetectionRaws {
  voicemail: DetectionResult;
  bot: DetectionResult;
  screening: DetectionResult;
  lowEngagement: DetectionResult;
  wrongNumber: DetectionResult;
  doNotDisturb: DetectionResult;
}

type ResolvedOutcomes = Pick<
  SimConversationMetrics,
  | "answered"
  | "voicemail_detected"
  | "bot_detected"
  | "call_screening"
  | "low_engagement"
  | "wrong_number"
  | "do_not_disturb"
  | "silent_call"
  | "customer_engaged"
  | "conversation_status"
>;

/** Pure conversation-outcome resolver. It owns the deterministic silent-call
 * gate, mutual exclusivity, normalized emission, and final status derivation;
 * LLM orchestration only supplies the six raw detection verdicts. */
export function resolveOutcomes(raws: ConversationDetectionRaws, ctx: ConversationInput): ResolvedOutcomes {
  const { voicemail, bot, screening, lowEngagement, wrongNumber, doNotDisturb } = raws;
  const answered = isAnswered(ctx);
  const voice = isVoiceChannel(ctx.transport);

  let vmFired = voicemail.available && voicemail.detected;
  let screenFired = screening.available && screening.detected;
  let botFired = bot.available && bot.detected;
  let wrongFired = wrongNumber.available && wrongNumber.detected;
  let dndFired = doNotDisturb.available && doNotDisturb.detected;
  let lowFired = lowEngagement.available && lowEngagement.detected;

  // ── a dead call is decided in CODE, not by the LLM ──
  // LOW_ENGAGEMENT is written around "a real human answered … but only gave minimal
  // greetings", and passes when "the metric does not apply". A transcript with no
  // caller speech falls outside that definition, so the judge correctly returns
  // not-detected — and the strongest possible case of low engagement scores clean.
  //
  // This is measured, not theorised. Round-4 prod audit (315 paired calls): AO's fire
  // rate climbs as the caller says less — 1.8% at 6+ turns, 11.5% at 3-5, 17.9% at 2,
  // 61.1% at 1 — then collapses to 0.0% at zero turns, inverting the trend exactly at
  // the precondition's boundary (P≈4.7e-06). Legacy fires on 13/13 of those calls. AO's
  // own stored reasoning says it outright: "No human response was recorded, so low
  // engagement does not apply."
  //
  // Opportunity gate: a one-way announcement gave the caller nothing to respond to.
  // Read the SPEECH transcript so a Tool_Call's arguments can never trip the gate;
  // `??` (not `||`) preserves an explicitly empty all-evidence transcript.
  const speech = ctx.speech_transcript ?? ctx.full_transcript;
  const agentAsked = /(^|\n)Agent:[^\n]*\?/.test(speech);
  const silentFired = voice && !answered && agentAsked;
  const effectiveLow = silentFired
    ? derivedDetection(
        "The caller never spoke. The agent asked and got no response for the whole call.",
        "derived in code: zero user turns in the judged transcript (isAnswered=false) with a delivered agent question",
      )
    : lowEngagement;

  if (silentFired) {
    // Silence outranks every counterparty detection: those detections require
    // speech from the far end, while this transcript contains none.
    vmFired = false;
    screenFired = false;
    botFired = false;
    wrongFired = false;
    dndFired = false;
    lowFired = true;
  } else if (vmFired || screenFired) {
    botFired = false;
    wrongFired = false;
    dndFired = false;
    lowFired = false;
  } else if (botFired) {
    wrongFired = false; dndFired = false; lowFired = false;
  } else if (wrongFired) {
    dndFired = false; lowFired = false;
  } else if (dndFired) {
    lowFired = false;
  }

  // Every detection follows the same finalization rule. This prevents a raw
  // verdict from leaking around a deterministic override on any output path.
  const voicemailFinal = vmFired ? det(voicemail) : suppressed(voicemail);
  const screeningFinal = screenFired ? det(screening) : suppressed(screening);
  const botFinal = botFired ? det(bot) : suppressed(bot);
  const wrongFinal = wrongFired ? det(wrongNumber) : suppressed(wrongNumber);
  const dndFinal = dndFired ? det(doNotDisturb) : suppressed(doNotDisturb);
  const lowFinal = lowFired ? det(effectiveLow) : suppressed(effectiveLow);

  let status = "answered";
  if (!answered) status = "unanswered";
  else if (vmFired) status = "voicemail_detected";
  else if (botFired) status = "bot_detected";
  else if (screenFired) status = "call_screening";
  else if (lowFired) status = "low_engagement";

  return {
    answered,
    voicemail_detected: voicemailFinal,
    bot_detected: botFinal,
    call_screening: screeningFinal,
    low_engagement: lowFinal,
    wrong_number: wrongFinal,
    do_not_disturb: dndFinal,
    silent_call: !answered,
    customer_engaged:
      answered && !vmFired && !screenFired && !botFired && !wrongFired && !dndFired && !lowFired,
    conversation_status: { status, reason: "", technical_reason: "" },
  };
}

/**
 * Score the conversation axis over the transcript and return real
 * `conversation_metrics`. Voice-only detections (voicemail / bot / call-screening
 * / STT) are gated on the transport; mutual exclusivity is enforced on the emitted
 * booleans; `conversation_status` is derived from the finalized outcomes.
 */
export async function evaluateConversationMetrics(
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<SimConversationMetrics> {
  const voice = isVoiceChannel(ctx.transport);
  const voiceOnlySkip = skippedDetection("not applicable on non-voice channel");

  const [voicemail, bot, screening, lowEng, wrong, dnd, sentiment, stt] = await Promise.all([
    voice ? runDetection(VOICEMAIL, ctx, provider) : Promise.resolve(voiceOnlySkip),
    voice ? runDetection(BOT, ctx, provider) : Promise.resolve(voiceOnlySkip),
    voice ? runDetection(CALL_SCREENING, ctx, provider) : Promise.resolve(voiceOnlySkip),
    runDetection(LOW_ENGAGEMENT, ctx, provider),
    runDetection(WRONG_NUMBER, ctx, provider),
    runDetection(DO_NOT_DISTURB, ctx, provider),
    runSentiment(ctx, provider),
    voice ? runStt(ctx, provider) : Promise.resolve(skippedStt()),
  ]);

  const outcomes = resolveOutcomes(
    { voicemail, bot, screening, lowEngagement: lowEng, wrongNumber: wrong, doNotDisturb: dnd },
    ctx,
  );

  // user_never_spoke must not double-flag a machine-answered call: voicemail /
  // bot / call-screening already describe "no human spoke", so defer to them and
  // keep this a clean "genuine human no-answer" signal. Mirrors dead_air's gate:
  // "can't confirm a human" (a machine classifier that failed open on a voice
  // call, available:false) is treated as "not a human", so a voicemail whose own
  // classifier call happened to fail can't leak through as user_never_spoke.
  // On text channels the machine axes are skippedDetection (available:false) but
  // `voice` is false, so this correctly does NOT suppress — a chat where the user
  // never replied still fires.
  const confirmsMachine = (d: { detected: boolean; available: boolean }) =>
    d.detected || (voice && d.available === false);
  const machineAnswered =
    confirmsMachine(outcomes.voicemail_detected) ||
    confirmsMachine(outcomes.bot_detected) ||
    confirmsMachine(outcomes.call_screening);
  const userNeverSpoke = machineAnswered
    ? skippedDetection(
        "machine answered (voicemail / bot / call-screening) — user_never_spoke not applicable",
      )
    : evaluateUserNeverSpoke(ctx);

  // Transfer axis: the fact is code-derived (free); the consent judge is the
  // one extra LLM call, and only on transferred sessions.
  const transferAxis = await evaluateTransferAxis(ctx, userNeverSpoke, provider);

  return {
    ...outcomes,
    user_never_spoke: det(userNeverSpoke),
    ...transferAxis,
    user_sentiment: {
      sentiment: sentiment.sentiment || "unknown",
      reason: sentiment.reason,
      technical_reason: sentiment.technical_reason,
      available: sentiment.available,
      passed: sentiment.available ? sentimentPassed(sentiment.sentiment) : undefined,
    },
    // Platform-neutral: the ingest path makes no runtime claim (was hardcoded
    // true here and overridden to false by the only caller).
    is_livekit: false,
    is_agent_runner: false,
    stt: { error_count: stt.error_count, recovered_count: stt.recovered_count, available: stt.available },
  };
}
