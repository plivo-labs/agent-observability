/**
 * Shared turn / audio / latency predicates.
 *
 * These rules were previously re-encoded inline across parse.ts,
 * metrics.ts, and evals/metrics.ts. Centralizing them here keeps the
 * "what counts as a turn", "did the audio pipeline run", and "what is
 * perceived latency" definitions in ONE place so the sessions-list
 * turn_count, the KPI tile total_turns, and the eval-run turn_count can
 * never silently disagree.
 *
 * Pure functions only — no I/O, no DB. Safe to import anywhere.
 */

/**
 * A turn completes when the *agent* replies. We count one turn per
 * assistant message; user messages and other roles (function calls,
 * handoffs) never count as agent turns. Used by parse.parseChatHistory,
 * metrics.buildSessionMetrics, and evals/metrics.computeCaseMetrics so
 * all three turn counters agree.
 */
export function isAgentTurn(role: unknown): boolean {
  return role === "assistant";
}

/**
 * Session-level audio-pipeline evidence. These fields only exist when
 * STT/TTS actually ran for an item, so their presence ANYWHERE in a
 * session marks it as a voice session; their total absence marks it as
 * text-only (typed, not spoken). Used by parse.parseChatHistory to clear
 * the role-based hasStt/hasTts fallback on text-only sessions.
 *
 * NOTE: this is intentionally distinct from the per-turn TTS-synthesis
 * gate metrics.ts uses for tts_characters (which also honours
 * tts_metadata). This predicate answers "did audio run somewhere in the
 * session", not "did TTS synthesize this specific turn".
 */
export function sawAudioEvidence(metric: Record<string, any> | null | undefined): boolean {
  if (!metric) return false;
  return (
    metric.transcription_delay != null ||
    metric.tts_node_ttfb != null ||
    metric.started_speaking_at != null ||
    metric.stopped_speaking_at != null
  );
}

/**
 * Perceived (user-facing) latency for a turn, in the same unit as the
 * inputs.
 *
 * CANONICAL DEFINITION: e2e_latency ?? llm_node_ttft.
 *
 * e2e_latency is the audio-pipeline measure (STT→LLM→TTS round trip).
 * Text-only sessions carry no e2e_latency on their per-turn metrics —
 * they only have llm_node_ttft — so we fall back to that. This is the
 * single source of truth shared by the read-path (metrics.ts) and the
 * agent-stats SQL (agents/db.ts PERCEIVED_MS_SQL).
 */
export function perceivedMs(
  e2e: number | null | undefined,
  llm: number | null | undefined,
): number | undefined {
  return e2e ?? llm ?? undefined;
}
