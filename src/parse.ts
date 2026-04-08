export interface ParsedChatHistory {
  chatItems: any[];
  turnCount: number;
  hasStt: boolean;
  hasLlm: boolean;
  hasTts: boolean;
  metrics: any[];
}

/**
 * Parses raw chat history JSON from agent-transport and extracts
 * turn counts, STT/LLM/TTS detection flags, and per-item metrics.
 *
 * Detection rules:
 * - hasStt: user-role message OR transcription_delay metric present
 * - hasLlm: llm_node_ttft metric present
 * - hasTts: assistant-role message OR tts_node_ttfb metric present
 */
export function parseChatHistory(chat: any): ParsedChatHistory {
  const chatItems: any[] = chat?.items ?? [];
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
