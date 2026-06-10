/**
 * Transforms raw chat_history and session_metrics stored in Postgres
 * into the structured SessionMetrics format the frontend expects.
 *
 * Raw metric values from agent-transport are in SECONDS — we convert to ms.
 * Content fields may be string arrays — we join them.
 */

import { isAgentTurn, perceivedMs } from "./turn-rules.js";

interface TurnRecord {
  turn_number: number;
  turn_id: string;
  user_text: string | null;
  agent_text: string | null;
  agent_first: boolean;
  interrupted: boolean;
  user_started_speaking_at?: string;
  user_stopped_speaking_at?: string;
  agent_started_speaking_at?: string;
  agent_stopped_speaking_at?: string;
  user_perceived_ms?: number;
  stt_delay_ms?: number;
  llm_ttft_ms?: number;
  tts_ttfb_ms?: number;
  turn_decision_ms?: number;
  user_speech_ms?: number;
  agent_speech_ms?: number;
  /** Time-to-first-audio: user stopped speaking → agent started speaking.
   * Clamped to ≥ 0 — barge-in overlap means "no wait", not negative wait. */
  ttfa_ms?: number;
  /** Silence between the previous turn's agent speech end and this turn's
   * user speech start. Clamped to ≥ 0. Undefined on the first turn. */
  inter_turn_gap_ms?: number;
  /** STT confidence for the user utterance, 0–1. Source:
   * `chat_history[item].transcript_confidence` from LiveKit's ChatMessage.
   * Present only when the STT plugin populates it (Deepgram, Google, etc.). */
  user_transcript_confidence?: number;
  llm_prompt_tokens?: number;
  llm_completion_tokens?: number;
  llm_total_tokens?: number;
  tts_characters?: number;
  tool_calls?: ToolCallRecord[];
  stt_provider?: string;
  stt_model?: string;
  llm_provider?: string;
  llm_model?: string;
  tts_provider?: string;
  tts_model?: string;
}

interface ToolCallRecord {
  name: string;
  call_id?: string;
  arguments: Record<string, unknown>;
  output?: string;
  is_error?: boolean;
  turn_number: number;
  timestamp: string;
}

interface VoiceSummary {
  ttfa?: { avg: number; p50: number; p90: number; p95: number; count: number };
  /** Session start → first agent speech ("first greeting" latency). */
  greeting_ttfa_ms?: number;
  user_speech_ms?: number;
  agent_speech_ms?: number;
  /** Agent share of total speaking time, 0–1. */
  talk_ratio?: number;
  longest_monologue_ms?: number;
  longest_monologue_turn?: number;
  user_wpm?: number;
  agent_wpm?: number;
  dead_air?: {
    threshold_ms: number;
    count: number;
    total_ms: number;
    max_ms: number;
    events: Array<{ turn_number: number; kind: "inter_turn" | "response"; gap_ms: number }>;
  };
  /** Fraction of session duration with nobody speaking, 0–1. Approximation:
   * overlapped (barge-in) speech double-subtracts, so the value is clamped. */
  silence_pct?: number;
}

interface MetricsSummary {
  total_turns: number;
  total_llm_tokens: number;
  total_llm_prompt_tokens: number;
  total_llm_completion_tokens: number;
  total_tts_characters: number;
  total_tool_calls: number;
  interruptions: number;
  /** interruptions / agent turns, 0–1. Undefined when there are no agent turns. */
  interruption_rate?: number;
  avg_user_perceived_ms?: number;
  p95_user_perceived_ms?: number;
  voice?: VoiceSummary;
  providers?: {
    stt_provider?: string;
    stt_model?: string;
    llm_provider?: string;
    llm_model?: string;
    tts_provider?: string;
    tts_model?: string;
  };
}

interface SessionMetrics {
  turns: TurnRecord[];
  tool_calls: ToolCallRecord[];
  summary: MetricsSummary;
}

/** Convert seconds to ms, returning undefined if input is nil */
function toMs(seconds: number | undefined | null): number | undefined {
  return seconds != null ? Math.round(seconds * 1000) : undefined;
}

/** Convert unix float seconds to ISO string, returning undefined if input is nil */
function toIso(unixSeconds: number | undefined | null): string | undefined {
  return unixSeconds != null ? new Date(unixSeconds * 1000).toISOString() : undefined;
}

/** Gaps (inter-turn or response) at/above this count as dead-air events. */
export const DEAD_AIR_THRESHOLD_MS = 3000;

/** Difference in ms between two ISO timestamps; undefined when either side
 * is missing or unparseable — callers must filter, never receive NaN. */
function isoDeltaMs(from: string | undefined, to: string | undefined): number | undefined {
  if (!from || !to) return undefined;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return b - a;
}

function clamp0(v: number | undefined): number | undefined {
  return v == null ? undefined : Math.max(0, v);
}

function wordCount(text: string | null): number {
  return text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

/** Normalize content that may be a string or string[] into a single string */
function normalizeText(content: unknown): string {
  if (Array.isArray(content)) return content.join(" ");
  if (typeof content === "string") return content;
  return "";
}

/**
 * LiveKit emits function-call arguments as a JSON-encoded string (OpenAI
 * convention). Parse into an object so the UI can iterate arg entries. On
 * parse failure, keep the raw string wrapped as { _raw: "..." } so the
 * renderer still shows something instead of treating the string as an object
 * and iterating char-by-char.
 */
function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "object" && parsed != null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { _raw: trimmed };
    } catch {
      return { _raw: trimmed };
    }
  }
  return {};
}

function findCallById(list: ToolCallRecord[], callId: string): ToolCallRecord | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].call_id === callId) return list[i];
  }
  return undefined;
}

function computeAvg(values: number[]): number {
  if (!values.length) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function computePercentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}

export interface BuildSessionMetricsOptions {
  /** Session wall-clock duration (row.duration_ms) — enables silence_pct. */
  durationMs?: number | string | null;
  /** Session start (row.started_at) — enables greeting_ttfa_ms. Accepts a
   * Date because bun:sql returns TIMESTAMPTZ columns as Date objects. */
  startedAt?: string | Date | null;
}

export function buildSessionMetrics(
  chatHistory: any[] | null,
  sessionMetrics: any | null,
  turnCount: number,
  options: BuildSessionMetricsOptions = {}
): SessionMetrics | null {
  if (!chatHistory?.length && !sessionMetrics) return null;

  // sessionMetrics may be:
  // - Array of per-item metrics (old format)
  // - { per_turn: [...], usage: [...] } (new format with model usage)
  const perTurnMetrics: any[] = Array.isArray(sessionMetrics)
    ? sessionMetrics
    : sessionMetrics?.per_turn ?? [];
  const usageData: any[] | null = Array.isArray(sessionMetrics)
    ? null
    : sessionMetrics?.usage ?? null;

  // Build a lookup of per-item metrics from session_metrics JSONB
  const metricsById = new Map<string, any>();
  for (const m of perTurnMetrics) {
    if (m.item_id) metricsById.set(m.item_id, m);
  }

  const turns: TurnRecord[] = [];
  const allToolCalls: ToolCallRecord[] = [];
  let turnNumber = 0;
  let totalTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTtsChars = 0;
  let totalToolCalls = 0;
  let totalInterruptions = 0;

  if (chatHistory) {
    let currentUserText: string | null = null;
    let currentUserMetrics: any = {};
    let currentUserConfidence: number | undefined;
    let pendingToolCalls: ToolCallRecord[] = [];

    for (const item of chatHistory) {
      const role = item.role ?? item.message?.role;
      const rawContent = item.content ?? item.message?.content ?? "";
      const text = normalizeText(rawContent);
      const itemMetrics = item.metrics ?? metricsById.get(item.id) ?? {};

      if (item.type === "message" && role === "user") {
        currentUserText = text;
        currentUserMetrics = { ...itemMetrics };
        // LiveKit's ChatMessage.transcript_confidence comes through pydantic
        // serialization at the chat-item level (not inside metrics).
        currentUserConfidence =
          typeof item.transcript_confidence === "number"
            ? item.transcript_confidence
            : undefined;
      } else if (item.type === "message" && isAgentTurn(role)) {
        // One turn per assistant message (turn-rules.isAgentTurn).
        turnNumber++;

        // Extract user-side timestamps BEFORE merge (both sides have started/stopped_speaking_at)
        const userStartedAt = toIso(currentUserMetrics.started_speaking_at);
        const userStoppedAt = toIso(currentUserMetrics.stopped_speaking_at);
        const turnDecisionMs = toMs(currentUserMetrics.end_of_turn_delay);
        const sttMeta = currentUserMetrics.stt_metadata;

        // Extract assistant-side timestamps and metadata from itemMetrics directly
        const agentStartedAt = toIso(itemMetrics.started_speaking_at);
        const agentStoppedAt = toIso(itemMetrics.stopped_speaking_at);
        const llmMeta = itemMetrics.llm_metadata;
        const ttsMeta = itemMetrics.tts_metadata;

        // Merge for latency fields (assistant values overwrite user values for shared keys)
        const m = { ...currentUserMetrics, ...itemMetrics };

        const sttMs = toMs(m.transcription_delay);
        const llmMs = toMs(m.llm_node_ttft);
        const ttsMs = toMs(m.tts_node_ttfb);
        const e2eMs = toMs(m.e2e_latency);
        // Canonical perceived latency: e2e_latency ?? llm_node_ttft. The
        // old +tts fallback is dropped — see src/turn-rules.ts perceivedMs
        // and the matching agents/db.ts PERCEIVED_MS_SQL fragment.
        const userPerceivedMs = perceivedMs(e2eMs, llmMs);

        const agentText = text;
        // Only count TTS characters when the audio pipeline actually
        // synthesized speech — TTS metadata or a tts_node_ttfb on the
        // turn are the reliable signals. On a text-only session the
        // assistant produces text but no TTS runs; counting agent_text
        // length there mislabels prose length as TTS work and clutters
        // the Token Usage panel with a metric that has no audio cost.
        //
        // This is a PER-TURN TTS-synthesis gate and is deliberately NOT
        // turn-rules.sawAudioEvidence(): that predicate answers the
        // session-level "did audio run anywhere" question (and excludes
        // tts_metadata), whereas here a turn with only tts_metadata still
        // counts as having synthesized speech.
        const ttsRan =
          ttsMs != null ||
          (ttsMeta != null &&
            typeof ttsMeta === "object" &&
            !Array.isArray(ttsMeta));
        const ttsChars = ttsRan ? agentText.length : 0;

        const turn: TurnRecord = {
          turn_number: turnNumber,
          turn_id: item.id ?? `turn-${turnNumber}`,
          user_text: currentUserText,
          agent_text: agentText,
          agent_first: currentUserText == null,
          interrupted: !!item.interrupted,
          user_started_speaking_at: userStartedAt,
          user_stopped_speaking_at: userStoppedAt,
          agent_started_speaking_at: agentStartedAt,
          agent_stopped_speaking_at: agentStoppedAt,
          user_perceived_ms: userPerceivedMs,
          stt_delay_ms: sttMs,
          llm_ttft_ms: llmMs,
          tts_ttfb_ms: ttsMs,
          turn_decision_ms: turnDecisionMs,
          user_transcript_confidence: currentUserConfidence,
          llm_prompt_tokens: m.llm_prompt_tokens,
          llm_completion_tokens: m.llm_completion_tokens,
          llm_total_tokens: m.llm_total_tokens ?? (((m.llm_prompt_tokens ?? 0) + (m.llm_completion_tokens ?? 0)) || undefined),
          tts_characters: ttsChars > 0 ? ttsChars : undefined,
          tool_calls: pendingToolCalls.length > 0 ? [...pendingToolCalls] : undefined,
          stt_provider: sttMeta?.model_provider,
          stt_model: sttMeta?.model_name,
          llm_provider: llmMeta?.model_provider,
          llm_model: llmMeta?.model_name,
          tts_provider: ttsMeta?.model_provider,
          tts_model: ttsMeta?.model_name,
        };

        if (item.interrupted) totalInterruptions++;
        if (turn.llm_total_tokens) totalTokens += turn.llm_total_tokens;
        if (turn.llm_prompt_tokens) totalPromptTokens += turn.llm_prompt_tokens;
        if (turn.llm_completion_tokens) totalCompletionTokens += turn.llm_completion_tokens;
        if (turn.tts_characters) totalTtsChars += turn.tts_characters;

        turns.push(turn);
        currentUserText = null;
        currentUserMetrics = {};
        currentUserConfidence = undefined;
        pendingToolCalls = [];
      } else if (item.type === "function_call" || item.type === "tool_call") {
        const rawArgs = item.arguments ?? item.function?.arguments ?? {};
        const tc: ToolCallRecord = {
          name: item.name ?? item.function?.name ?? "unknown",
          call_id: item.call_id,
          arguments: parseToolArgs(rawArgs),
          output: item.output,
          is_error: item.is_error,
          turn_number: turnNumber + 1,
          timestamp: item.timestamp ?? new Date().toISOString(),
        };
        pendingToolCalls.push(tc);
        allToolCalls.push(tc);
        totalToolCalls++;
      } else if (item.type === "function_call_output" || item.type === "tool_call_output") {
        // LiveKit emits function_call and function_call_output as separate chat
        // items. Merge the output back into the matching call by call_id, or
        // fall back to the most recent pending call if the id isn't present.
        const callId = item.call_id;
        const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
        const isError = item.is_error;
        const target =
          (callId && (findCallById(pendingToolCalls, callId) ?? findCallById(allToolCalls, callId)))
          ?? pendingToolCalls[pendingToolCalls.length - 1]
          ?? allToolCalls[allToolCalls.length - 1];
        if (target) {
          target.output = output;
          if (isError != null) target.is_error = isError;
        }
      }
    }

    // Flush state that wasn't closed off by an assistant message. Three cases
    // we need to cover:
    //   (a) user spoke at the very start and the agent never replied
    //   (b) a conversation with prior turns ends with a final user message
    //       that the agent never answered — caller hung up right after
    //       speaking, or the agent's reply was cut off. Recording has the
    //       audio; chat history has the user item; without this flush, the
    //       UI drops it.
    //   (c) agent called a tool (function_call) but the session ended before
    //       a follow-up assistant message — orphan tool calls.
    // Emit a "partial" turn so trailing user text and/or tool calls still
    // appear in the transcript.
    const hasOrphanToolCalls = pendingToolCalls.length > 0;
    const hasDanglingUserText = currentUserText != null;
    if (hasOrphanToolCalls || hasDanglingUserText) {
      turnNumber++;
      turns.push({
        turn_number: turnNumber,
        turn_id: `turn-${turnNumber}-partial`,
        user_text: currentUserText,
        agent_text: null,
        // Match the normal-path rule: if there's no user text, the agent
        // must have started the turn (orphan tool call with no preceding
        // user speech). Previously hardcoded `false`, which suppressed
        // the "Agent initiated" badge on agent-initiated orphan turns.
        agent_first: currentUserText == null,
        interrupted: false,
        user_started_speaking_at: toIso(currentUserMetrics.started_speaking_at),
        user_stopped_speaking_at: toIso(currentUserMetrics.stopped_speaking_at),
        turn_decision_ms: toMs(currentUserMetrics.end_of_turn_delay),
        user_transcript_confidence: currentUserConfidence,
        tool_calls: hasOrphanToolCalls ? [...pendingToolCalls] : undefined,
      });
      pendingToolCalls = [];
    }
  }

  // Voice-dynamics post-pass: runs over the finished turn list so flushed
  // partial turns (caller hung up mid-conversation) get identical treatment.
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const userMs = isoDeltaMs(t.user_started_speaking_at, t.user_stopped_speaking_at);
    const agentMs = isoDeltaMs(t.agent_started_speaking_at, t.agent_stopped_speaking_at);
    // A negative duration is a corrupt timestamp pair, not meaningful — drop it.
    if (userMs != null && userMs > 0) t.user_speech_ms = userMs;
    if (agentMs != null && agentMs > 0) t.agent_speech_ms = agentMs;
    t.ttfa_ms = clamp0(isoDeltaMs(t.user_stopped_speaking_at, t.agent_started_speaking_at));
    if (i > 0) {
      t.inter_turn_gap_ms = clamp0(
        isoDeltaMs(turns[i - 1].agent_stopped_speaking_at, t.user_started_speaking_at)
      );
    }
  }

  // Voice summary aggregates — `voice` is emitted only when something was
  // measurable, so text-only sessions (no speaking timestamps) omit it.
  const ttfaValues = turns
    .map((t) => t.ttfa_ms)
    .filter((v): v is number => v != null);

  let userSpeechMs = 0;
  let agentSpeechMs = 0;
  let speechMeasured = false;
  let longestMonologueMs: number | undefined;
  let longestMonologueTurn: number | undefined;
  let userWords = 0;
  let userSpokenMs = 0;
  let agentWords = 0;
  let agentSpokenMs = 0;
  let gapMeasured = false;
  const deadAirEvents: Array<{ turn_number: number; kind: "inter_turn" | "response"; gap_ms: number }> = [];

  for (const t of turns) {
    if (t.user_speech_ms != null) {
      userSpeechMs += t.user_speech_ms;
      speechMeasured = true;
      const words = wordCount(t.user_text);
      // WPM pairs words with the same turn's measured speech time, so a
      // turn with text but no timestamps can't inflate the rate.
      if (words > 0) {
        userWords += words;
        userSpokenMs += t.user_speech_ms;
      }
    }
    if (t.agent_speech_ms != null) {
      agentSpeechMs += t.agent_speech_ms;
      speechMeasured = true;
      if (longestMonologueMs == null || t.agent_speech_ms > longestMonologueMs) {
        longestMonologueMs = t.agent_speech_ms;
        longestMonologueTurn = t.turn_number;
      }
      const words = wordCount(t.agent_text);
      if (words > 0) {
        agentWords += words;
        agentSpokenMs += t.agent_speech_ms;
      }
    }
    if (t.inter_turn_gap_ms != null) {
      gapMeasured = true;
      if (t.inter_turn_gap_ms >= DEAD_AIR_THRESHOLD_MS) {
        deadAirEvents.push({ turn_number: t.turn_number, kind: "inter_turn", gap_ms: t.inter_turn_gap_ms });
      }
    }
    if (t.ttfa_ms != null) {
      gapMeasured = true;
      if (t.ttfa_ms >= DEAD_AIR_THRESHOLD_MS) {
        deadAirEvents.push({ turn_number: t.turn_number, kind: "response", gap_ms: t.ttfa_ms });
      }
    }
  }

  const startedAtIso =
    options.startedAt instanceof Date
      ? options.startedAt.toISOString()
      : options.startedAt ?? undefined;
  const firstAgentStart = turns.find((t) => t.agent_started_speaking_at)?.agent_started_speaking_at;
  const greetingTtfaMs = clamp0(isoDeltaMs(startedAtIso, firstAgentStart));

  const totalSpeechMs = userSpeechMs + agentSpeechMs;
  const sessionDurationMs = options.durationMs != null ? Number(options.durationMs) : undefined;
  const silencePct =
    speechMeasured && sessionDurationMs != null && Number.isFinite(sessionDurationMs) && sessionDurationMs > 0
      ? Math.min(1, Math.max(0, (sessionDurationMs - totalSpeechMs) / sessionDurationMs))
      : undefined;

  const voice: VoiceSummary = {};
  if (ttfaValues.length > 0) {
    voice.ttfa = {
      avg: computeAvg(ttfaValues),
      p50: computePercentile(ttfaValues, 0.5),
      p90: computePercentile(ttfaValues, 0.9),
      p95: computePercentile(ttfaValues, 0.95),
      count: ttfaValues.length,
    };
  }
  if (greetingTtfaMs != null) voice.greeting_ttfa_ms = greetingTtfaMs;
  if (speechMeasured) {
    voice.user_speech_ms = userSpeechMs;
    voice.agent_speech_ms = agentSpeechMs;
    if (totalSpeechMs > 0) voice.talk_ratio = agentSpeechMs / totalSpeechMs;
  }
  if (longestMonologueMs != null) {
    voice.longest_monologue_ms = longestMonologueMs;
    voice.longest_monologue_turn = longestMonologueTurn;
  }
  if (userWords > 0 && userSpokenMs > 0) voice.user_wpm = Math.round(userWords / (userSpokenMs / 60000));
  if (agentWords > 0 && agentSpokenMs > 0) voice.agent_wpm = Math.round(agentWords / (agentSpokenMs / 60000));
  if (gapMeasured) {
    voice.dead_air = {
      threshold_ms: DEAD_AIR_THRESHOLD_MS,
      count: deadAirEvents.length,
      total_ms: deadAirEvents.reduce((sum, e) => sum + e.gap_ms, 0),
      max_ms: deadAirEvents.reduce((max, e) => Math.max(max, e.gap_ms), 0),
      events: deadAirEvents,
    };
  }
  if (silencePct != null) voice.silence_pct = silencePct;

  const agentTurnCount = turns.filter((t) => t.agent_text != null).length;

  // Compute summary stats
  const perceivedValues = turns
    .map((t) => t.user_perceived_ms)
    .filter((v): v is number => v != null);

  // If per-turn tokens are missing, compute from session-level usage data.
  // Usage entries have: { provider, model, input_tokens?, output_tokens?, characters_count?, audio_duration? }
  // LLM entries have input_tokens/output_tokens; TTS entries have characters_count; STT have audio_duration only.
  if (totalTokens === 0 && Array.isArray(usageData)) {
    for (const u of usageData) {
      if (u.input_tokens != null && u.characters_count == null) {
        totalPromptTokens += u.input_tokens ?? 0;
        totalCompletionTokens += u.output_tokens ?? 0;
        totalTokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
      }
    }
  }
  if (totalTtsChars === 0 && Array.isArray(usageData)) {
    for (const u of usageData) {
      if (u.characters_count != null) {
        totalTtsChars += u.characters_count;
      }
    }
  }

  // Derive session-level providers from first turn with each metadata type
  const firstStt = turns.find(t => t.stt_provider);
  const firstLlm = turns.find(t => t.llm_provider);
  const firstTts = turns.find(t => t.tts_provider);

  const summary: MetricsSummary = {
    total_turns: turns.length || turnCount,
    total_llm_tokens: totalTokens,
    total_llm_prompt_tokens: totalPromptTokens,
    total_llm_completion_tokens: totalCompletionTokens,
    total_tts_characters: totalTtsChars,
    total_tool_calls: totalToolCalls,
    interruptions: totalInterruptions,
    interruption_rate: agentTurnCount > 0 ? totalInterruptions / agentTurnCount : undefined,
    avg_user_perceived_ms: perceivedValues.length > 0 ? computeAvg(perceivedValues) : undefined,
    p95_user_perceived_ms: perceivedValues.length > 0 ? computePercentile(perceivedValues, 0.95) : undefined,
    voice: Object.keys(voice).length > 0 ? voice : undefined,
    providers: (firstStt || firstLlm || firstTts) ? {
      stt_provider: firstStt?.stt_provider,
      stt_model: firstStt?.stt_model,
      llm_provider: firstLlm?.llm_provider,
      llm_model: firstLlm?.llm_model,
      tts_provider: firstTts?.tts_provider,
      tts_model: firstTts?.tts_model,
    } : undefined,
  };

  return { turns, tool_calls: allToolCalls, summary };
}
