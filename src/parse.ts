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
 * - hasStt: user-role message OR transcription_delay metric present
 * - hasLlm: llm_node_ttft metric present
 * - hasTts: assistant-role message OR tts_node_ttfb metric present
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

  for (const item of chatItems) {
    if (item.type === "message") {
      turnCount++;
      const role = item.role ?? item.message?.role;
      if (role === "user") hasStt = true;
      if (role === "assistant") hasTts = true;
    }

    const m = item.metrics ?? {};
    if (m.llm_node_ttft) hasLlm = true;
    if (m.tts_node_ttfb) hasTts = true;
    if (m.transcription_delay) hasStt = true;

    if (Object.keys(m).length > 0) {
      metrics.push({ item_id: item.id, role: item.role, ...m });
    }
  }

  return { chatItems, turnCount, hasStt, hasLlm, hasTts, metrics };
}
