export interface ParsedChatHistory {
  chatItems: any[];
  turnCount: number;
  hasStt: boolean;
  hasLlm: boolean;
  hasTts: boolean;
  metrics: any[];
}

/**
 * Convert camelCase key to snake_case.
 * e.g. llmNodeTtft -> llm_node_ttft, startedSpeakingAt -> started_speaking_at
 */
function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

/**
 * Recursively normalize object keys from camelCase to snake_case.
 * The Node (TS) SDK uses camelCase, the Python SDK uses snake_case.
 * We normalize everything to snake_case for consistent processing.
 */
export function normalizeKeys(obj: any): any {
  if (obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(normalizeKeys);

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = toSnakeCase(key);
    out[snakeKey] = normalizeKeys(value);
  }
  return out;
}

/**
 * Parses raw chat history JSON from agent-transport and extracts
 * turn counts, STT/LLM/TTS detection flags, and per-item metrics.
 *
 * Normalizes camelCase keys (Node SDK) to snake_case (Python SDK format)
 * so the metrics builder works consistently for both.
 *
 * Detection rules:
 * - hasLlm: llm_node_ttft metric present
 * - hasStt/hasTts: a user/assistant message implies STT/TTS *only in a voice
 *   session*. The session is treated as voice when any item carries an audio
 *   metric (transcription_delay, tts_node_ttfb, started/stopped_speaking_at).
 *   With zero audio metrics it's text-only — messages are typed, not spoken —
 *   so hasStt/hasTts stay false.
 */
export function parseChatHistory(chat: any): ParsedChatHistory {
  // Normalize entire payload to snake_case
  const normalized = normalizeKeys(chat);

  // Support both formats:
  // - Direct: { items: [...] } (chat_history.to_dict())
  // - Wrapped: { chat_history: { items: [...] }, usage: [...], ... } (report.to_dict())
  const chatItems: any[] = normalized?.items ?? normalized?.chat_history?.items ?? [];
  let turnCount = 0;
  let hasStt = false;
  let hasLlm = false;
  let hasTts = false;
  const metrics: any[] = [];

  let sawAudioSignal = false;

  for (const item of chatItems) {
    if (item.type === "message") {
      const role = item.role ?? item.message?.role;
      // Count one turn per assistant message — a turn isn't complete
      // until the agent replies. Matches metrics.ts:turnNumber so the
      // sessions-list `turn_count` column and the KPI tile's `total_turns`
      // never disagree (they used to: this loop counted every message
      // including user-only items, so a 4-turn dialog showed as 8).
      if (role === "assistant") turnCount++;
      // Role-based STT/TTS is a voice-session fallback (a user/assistant
      // message implies speech even when this item's own metric is absent).
      // Cleared after the loop if the session turns out to be text-only.
      if (role === "user") hasStt = true;
      if (role === "assistant") hasTts = true;
    }

    const m = item.metrics ?? {};
    if (m.llm_node_ttft) hasLlm = true;
    if (m.tts_node_ttfb) hasTts = true;
    if (m.transcription_delay) hasStt = true;
    // Audio-pipeline evidence: these only exist when STT/TTS actually ran.
    // Their total absence across the session marks it as text-only.
    if (
      m.transcription_delay != null ||
      m.tts_node_ttfb != null ||
      m.started_speaking_at != null ||
      m.stopped_speaking_at != null
    ) {
      sawAudioSignal = true;
    }

    if (Object.keys(m).length > 0) {
      metrics.push({ item_id: item.id, role: item.role, ...m });
    }
  }

  // Text-only sessions carry user/assistant messages but never run STT/TTS.
  // With no audio metric anywhere, the role-based flags above would mislabel
  // them — trust the absence of audio evidence and report no STT/TTS. Voice
  // sessions (any audio metric present) keep the role-based fallback.
  if (!sawAudioSignal) {
    hasStt = false;
    hasTts = false;
  }

  return { chatItems, turnCount, hasStt, hasLlm, hasTts, metrics };
}
