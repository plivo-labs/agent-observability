// Jev counts state tokens itself and rejects a request whose state exceeds
// ~32k. We decide BEFORE sending, so the estimate must not under-count: measured
// against usage.input_tokens, spoken transcript text tokenizes at ~0.35 tok/char
// and prompt/JSON prose at ~0.25 — a flat chars/4 under-counts transcript-heavy
// states by up to 1.4x and was the cause of every overflow in the benchmark.

export const TRANSCRIPT_TOKENS_PER_CHAR = 0.35;
export const CONFIG_TOKENS_PER_CHAR = 0.25;

/** State fields that carry rendered speech (estimated at the transcript rate). */
export const TRANSCRIPT_FIELDS: ReadonlySet<string> = new Set([
  "conversation_history",
  "node_transcript",
  "caller_said",
  "agent_spoken",
  "tool_results",
]);

export function estimateJevTokens(state: unknown): number {
  // A bare-string state is always a rendered transcript (the conversation
  // detections take one), so it takes the transcript rate.
  if (typeof state === "string") return Math.ceil(state.length * TRANSCRIPT_TOKENS_PER_CHAR);
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return Math.ceil(JSON.stringify(state ?? "").length * CONFIG_TOKENS_PER_CHAR);
  }
  let tokens = 0;
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    const chars = JSON.stringify(value ?? "").length + key.length + 4;
    tokens += chars * (TRANSCRIPT_FIELDS.has(key) ? TRANSCRIPT_TOKENS_PER_CHAR : CONFIG_TOKENS_PER_CHAR);
  }
  return Math.ceil(tokens);
}

export const TOOL_RESULT_CLIP_CHARS = 1500;
const CLIP_MARK = " …[tool output clipped]";

/** The labels the transcript renderer puts at the start of a line. A line with
 *  none of them is a continuation of the block above it — a tool that returns
 *  text spans many lines. */
const LINE_LABELS = ["User:", "Agent:", "Tool_Call:", "Tool_Result:", "System_Note:", "Agent_Handoff:"];

/** A lookup can return >100k chars in ONE tool result, across as many lines as
 *  it likes; the judges read only its head. This is the only thing ever cut
 *  from a state — never a spoken turn, never config. */
export function clipToolResults(transcript: string, max: number = TOOL_RESULT_CLIP_CHARS): string {
  if (!transcript.includes("Tool_Result:")) return transcript;
  const out: string[] = [];
  let inResult = false;
  let used = 0;
  for (const line of transcript.split("\n")) {
    const starts = LINE_LABELS.some((l) => line.startsWith(l));
    if (starts) {
      inResult = line.startsWith("Tool_Result:");
      used = 0;
    }
    if (!inResult) {
      out.push(line);
      continue;
    }
    if (used >= max) continue;
    const room = max - used;
    used += line.length + 1;
    out.push(line.length > room ? line.slice(0, room) + CLIP_MARK : line);
  }
  return out.join("\n");
}

/** Tokens a question costs on the wire (instructions + both criteria). */
export function estimateQuestionTokens(q: { instructions: string; criteria: { true: string; false: string } }): number {
  return Math.ceil((q.instructions.length + q.criteria.true.length + q.criteria.false.length + 40) * CONFIG_TOKENS_PER_CHAR);
}

/** Jev enforces two limits: state + the LONGEST question (~32k) and state +
 *  ALL questions (~64k). Both are estimated here so a request is checked
 *  against the same shape the API measures. */
export function estimateRequestTokens(
  state: unknown,
  questions: Record<string, { instructions: string; criteria: { true: string; false: string } }>,
): { state: number; longest: number; total: number } {
  const stateTokens = estimateJevTokens(state);
  let longest = 0;
  let sum = 0;
  for (const q of Object.values(questions)) {
    const tokens = estimateQuestionTokens(q);
    longest = Math.max(longest, tokens);
    sum += tokens;
  }
  return { state: stateTokens, longest: stateTokens + longest, total: stateTokens + sum };
}
