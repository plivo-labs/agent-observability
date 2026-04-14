/**
 * Transforms raw chat_history and session_metrics stored in Postgres
 * into the structured SessionMetrics format the frontend expects.
 *
 * Raw metric values from agent-transport are in SECONDS — we convert to ms.
 * Content fields may be string arrays — we join them.
 */

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

interface MetricsSummary {
  total_turns: number;
  total_llm_tokens: number;
  total_llm_prompt_tokens: number;
  total_llm_completion_tokens: number;
  total_tts_characters: number;
  total_tool_calls: number;
  interruptions: number;
  avg_user_perceived_ms?: number;
  p95_user_perceived_ms?: number;
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

/** Normalize content that may be a string or string[] into a single string */
function normalizeText(content: unknown): string {
  if (Array.isArray(content)) return content.join(" ");
  if (typeof content === "string") return content;
  return "";
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

export function buildSessionMetrics(
  chatHistory: any[] | null,
  sessionMetrics: any | null,
  turnCount: number
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
    let pendingToolCalls: ToolCallRecord[] = [];

    for (const item of chatHistory) {
      const role = item.role ?? item.message?.role;
      const rawContent = item.content ?? item.message?.content ?? "";
      const text = normalizeText(rawContent);
      const itemMetrics = item.metrics ?? metricsById.get(item.id) ?? {};

      if (item.type === "message" && role === "user") {
        currentUserText = text;
        currentUserMetrics = { ...itemMetrics };
      } else if (item.type === "message" && role === "assistant") {
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
        const perceivedMs = e2eMs ?? (llmMs != null && ttsMs != null ? llmMs + ttsMs : llmMs);

        const agentText = text;
        const ttsChars = agentText.length;

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
          user_perceived_ms: perceivedMs,
          stt_delay_ms: sttMs,
          llm_ttft_ms: llmMs,
          tts_ttfb_ms: ttsMs,
          turn_decision_ms: turnDecisionMs,
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
        pendingToolCalls = [];
      } else if (item.type === "function_call" || item.type === "tool_call") {
        const tc: ToolCallRecord = {
          name: item.name ?? item.function?.name ?? "unknown",
          call_id: item.call_id,
          arguments: item.arguments ?? item.function?.arguments ?? {},
          output: item.output,
          is_error: item.is_error,
          turn_number: turnNumber + 1,
          timestamp: item.timestamp ?? new Date().toISOString(),
        };
        pendingToolCalls.push(tc);
        allToolCalls.push(tc);
        totalToolCalls++;
      }
    }

    // Handle remaining user text without agent response
    if (currentUserText != null && turnNumber === 0) {
      turnNumber++;
      turns.push({
        turn_number: turnNumber,
        turn_id: `turn-${turnNumber}`,
        user_text: currentUserText,
        agent_text: null,
        agent_first: false,
        interrupted: false,
      });
    }
  }

  // Compute summary stats
  const perceivedValues = turns
    .map((t) => t.user_perceived_ms)
    .filter((v): v is number => v != null);

  // If per-turn tokens are missing, compute from session-level usage data.
  // Usage entries have: { provider, model, input_tokens?, output_tokens?, characters_count?, audio_duration? }
  // LLM entries have input_tokens/output_tokens; TTS entries have characters_count; STT have audio_duration only.
  if (totalTokens === 0 && usageData) {
    for (const u of usageData) {
      if (u.input_tokens != null && u.characters_count == null) {
        totalPromptTokens += u.input_tokens ?? 0;
        totalCompletionTokens += u.output_tokens ?? 0;
        totalTokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
      }
    }
  }
  if (totalTtsChars === 0 && usageData) {
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
    avg_user_perceived_ms: perceivedValues.length > 0 ? computeAvg(perceivedValues) : undefined,
    p95_user_perceived_ms: perceivedValues.length > 0 ? computePercentile(perceivedValues, 0.95) : undefined,
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
