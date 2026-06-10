/**
 * Shared SQL fragments for aggregate stats queries (per-agent stats in
 * src/agents/db.ts and fleet-wide stats in src/analytics/db.ts). One
 * definition per metric so the queries can't drift apart.
 */

// `interval` feeds NOW() - $::interval and accepts the natural plural
// form. `bucket` feeds date_trunc(), which takes the unit name only —
// "hour"/"day" rather than "1 hour"/"1 day".
export const RANGE_TO_INTERVAL: Record<string, { interval: string; bucket: string }> = {
  "24h": { interval: "24 hours", bucket: "hour" },
  "7d":  { interval: "7 days",   bucket: "hour" },
  "30d": { interval: "30 days",  bucket: "day" },
};

// jsonb_array_elements blows up on NULL or non-array values, so we guard
// with jsonb_typeof before unpacking. The pattern repeats across the
// bucket / totals / provider queries.
export const PER_TURN_ELEMS = (col: string) => `
  jsonb_array_elements(
    CASE WHEN jsonb_typeof(${col}->'per_turn') = 'array'
         THEN ${col}->'per_turn'
         ELSE '[]'::jsonb
    END
  )
`;

// Perceived-latency definition, in ONE place. Canonical fallback:
//   e2e_latency ?? llm_node_ttft
// e2e_latency is the audio-pipeline measure (STT→LLM→TTS round trip);
// text-only sessions have no e2e_latency on their per-turn metrics —
// they only carry llm_node_ttft — so fall back to that. Same rule the
// read path uses (src/turn-rules.ts perceivedMs / metrics.ts); without
// it, text-mode agents show an empty p95 chart on the Overview tab.
// Result is multiplied by 1000 (seconds → ms). `m` must be the
// per-turn element alias produced by PER_TURN_ELEMS.
export const PERCEIVED_MS_SQL = `
  COALESCE(
    NULLIF(m->>'e2e_latency', '')::float,
    NULLIF(m->>'llm_node_ttft', '')::float
  ) * 1000`;

// Companion WHERE filter: keep only per-turn rows carrying a numeric
// value for at least one of the two fields PERCEIVED_MS_SQL reads.
export const PERCEIVED_MS_WHERE = `
  (m->>'e2e_latency') ~ '^[0-9.]+$'
     OR (m->>'llm_node_ttft') ~ '^[0-9.]+$'`;

// Same NULL/non-array guard for chat_history (raw chat items, not the
// per_turn metrics array). Element alias convention: `item`.
export const CHAT_HISTORY_ELEMS = (col: string) => `
  jsonb_array_elements(
    CASE WHEN jsonb_typeof(${col}) = 'array'
         THEN ${col}
         ELSE '[]'::jsonb
    END
  )
`;

// Turn semantics match src/metrics.ts: one turn per assistant message.
export const ASSISTANT_MSG_WHERE = `
  (item->>'type') = 'message' AND (item->>'role') = 'assistant'`;

// JSONB booleans stringify to 'true'/'false' through ->>.
export const INTERRUPTED_WHERE = `(item->>'interrupted') = 'true'`;
