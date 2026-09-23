import type { ConversationInput, NodeEvalInput } from "../evals-engine/types.js";
import { clipToolResults, estimateJevTokens } from "./tokens.js";

// Hallucination grounding: code does the RETRIEVAL, Jev does the judgement.
//
// Measured on 300 live sessions: 73% of the disputed hallucination flags were
// the agent reading its own configured content back — grounded, but buried mid-way
// through a 20-50k-char prompt where the model stopped finding it. So the state
// carries (a) the full node prompt, (b) compact windows of every OTHER config
// location that mentions a token the agent actually spoke, and (c) the spoken
// lines themselves; and any specific value code cannot ground anywhere becomes
// its own narrow question instead of a vague "anything unsupported?".

const STOP = new Set([
  "hi", "hello", "this", "thank", "thanks", "great", "no", "yes", "i", "is", "are", "could", "since",
  "the", "you", "may", "if", "okay", "ok", "sorry", "of", "course", "so", "and", "or", "to", "for", "in",
  "on", "it", "we", "my", "your", "can", "just", "let", "please", "what", "how", "would", "do", "did",
  "am", "have", "has", "that", "there", "here", "a", "an", "all", "any", "not", "but", "with", "from",
  "as", "at", "by", "be", "was", "were", "will", "its", "our", "he", "she", "they", "them", "us", "me",
]);

/** Words that are specific-looking but never an invention on their own. */
const BENIGN = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
  "november", "december", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "today", "tomorrow", "according", "wishing", "glad", "alright", "sure", "absolutely", "perfect",
  "wonderful", "awesome", "excellent", "unfortunately", "fortunately", "certainly", "definitely",
  "exactly", "understood", "noted", "welcome", "goodbye", "bye", "again", "anything", "everything",
  "something", "nothing", "one", "two", "three", "four", "five", "first", "second", "also", "well",
  "right", "got", "let's", "i'll", "i'm", "we'll", "we're", "you're", "that's", "it's", "don't",
  "can't", "english", "spanish",
]);

/** US state name → postal abbreviation: config commonly stores "TX" where the
 *  agent says "Texas", which is grounding, not invention. */
const STATE_ABBREVIATIONS: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co",
  connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga", hawaii: "hi", idaho: "id",
  illinois: "il", indiana: "in", iowa: "ia", kansas: "ks", kentucky: "ky", louisiana: "la",
  maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms",
  missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv", hampshire: "nh", jersey: "nj",
  mexico: "nm", york: "ny", carolina: "nc", dakota: "nd", ohio: "oh", oklahoma: "ok", oregon: "or",
  pennsylvania: "pa", island: "ri", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt",
  virginia: "va", washington: "wa", wisconsin: "wi", wyoming: "wy",
};

const TOKEN_RE = /[A-Za-z][A-Za-z'\-]+|\d[\d\s\-]{1,}/g;

/** Specific values in a piece of agent speech: capitalized words (names,
 *  places, products) and digit runs (numbers, ids, dates), in order of first
 *  appearance so the result is deterministic. */
export function keyTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    const raw = match[0]!.trim();
    if (!raw) continue;
    const token = /^\d/.test(raw) ? raw.replace(/\s+/g, "") : raw.toLowerCase();
    if (/^\d/.test(raw)) {
      if (token.length < 2 || seen.has(token)) continue;
    } else {
      // Capitalization is the signal a word is a specific value (a name, a
      // place, a product) rather than ordinary speech.
      if (raw[0] !== raw[0]!.toUpperCase() || raw[0] === raw[0]!.toLowerCase()) continue;
      if (raw.length <= 2 || STOP.has(token) || seen.has(token)) continue;
    }
    seen.add(token);
    out.push(token);
  }
  return out;
}

function transcriptLines(transcript: string, prefixes: string[]): string[] {
  return transcript.split("\n").filter((l) => prefixes.some((p) => l.startsWith(p)));
}

/** What was SAID, without the speaker label. The label is not a spoken value,
 *  and "Agent" is capitalized on every single line — tokenizing it makes the
 *  most common word in the transcript also the most retrieved one. */
function spokenText(lines: string[]): string {
  return lines.map((l) => l.replace(/^[A-Za-z_]+:\s*/, "")).join(" ");
}

/** Everything a spoken value could legitimately come from: every node's
 *  instructions, the global prompt and variables, the FULL runtime system
 *  messages (the rendered prompt with this call's details filled in — the
 *  stored config template alone does not contain them), the caller's own
 *  words, and tool calls/results. */
function groundingPool(call: ConversationInput, transcript: string): string {
  const parts: string[] = [];
  for (const n of call.nodes ?? []) parts.push(n.node_prompt ?? "");
  parts.push(call.global_prompt ?? "");
  if (call.global_variables) parts.push(JSON.stringify(call.global_variables));
  if (call.pronunciation_guides) parts.push(JSON.stringify(call.pronunciation_guides));
  for (const m of call.system_messages ?? []) parts.push(m);
  parts.push(...transcriptLines(transcript, ["User:", "Tool_Call:", "Tool_Result:"]));
  return parts.join("\n");
}

/** Config-only pool (no transcript): what the retrieval windows are cut from. */
function configPool(call: ConversationInput): string {
  const parts: string[] = [];
  for (const n of call.nodes ?? []) parts.push(n.node_prompt ?? "");
  parts.push(call.global_prompt ?? "");
  if (call.global_variables) parts.push(JSON.stringify(call.global_variables));
  for (const m of call.system_messages ?? []) parts.push(m);
  return parts.join("\n");
}

const WINDOW_BEFORE = 220;
const WINDOW_AFTER = 260;
const WINDOW_MERGE_GAP = 40;
const MAX_WINDOWS = 120;
/** Windows one token may claim. Without it a word the config repeats — and the
 *  speaker labels are the worst offenders — takes the whole budget and every
 *  other spoken value is retrieved against nothing. */
const MAX_WINDOWS_PER_TOKEN = 8;
const MAX_EXCERPTS = 40;
const EXCERPT_CHARS = 500;
const LINE_CHARS = 400;

/** Windows of config around every token the agent actually spoke, merged and
 *  capped. Window-based (not sentence-based) on purpose: a templated config
 *  line can be thousands of characters long, and a sentence splitter drops it. */
export function configExcerpts(call: ConversationInput, agentLines: string[]): string[] {
  const config = configPool(call);
  if (!config) return [];
  const low = config.toLowerCase();
  const windows: Array<[number, number]> = [];
  for (const token of keyTokens(spokenText(agentLines))) {
    let start = 0;
    let claimed = 0;
    while (claimed < MAX_WINDOWS_PER_TOKEN && windows.length < MAX_WINDOWS) {
      const i = low.indexOf(token, start);
      if (i < 0) break;
      windows.push([Math.max(0, i - WINDOW_BEFORE), Math.min(config.length, i + token.length + WINDOW_AFTER)]);
      claimed++;
      start = i + token.length;
    }
    if (windows.length >= MAX_WINDOWS) break;
  }
  windows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // Merge neighbours, but never past the excerpt length: a longer block would
  // be truncated from the front, which drops the later matches that created it
  // — the retrieval would then return config that grounds nothing.
  const merged: Array<[number, number]> = [];
  for (const [a, b] of windows) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + WINDOW_MERGE_GAP && Math.max(last[1], b) - last[0] <= EXCERPT_CHARS) {
      last[1] = Math.max(last[1], b);
    } else {
      merged.push([a, b]);
    }
  }
  return merged.slice(0, MAX_EXCERPTS).map(([a, b]) => config.slice(a, b).trim());
}

export interface ResidualClaim {
  token: string;
  line: string;
}

/** Specific values the agent SPOKE that code cannot find anywhere — the only
 *  ones worth asking Jev about individually. */
export function residualClaims(call: ConversationInput, transcript: string, max: number): ResidualClaim[] {
  const agentLines = transcriptLines(transcript, ["Agent:"]);
  const pool = groundingPool(call, transcript).toLowerCase();
  const poolDigits = pool.replace(/\D/g, "");
  const out: ResidualClaim[] = [];
  for (const token of keyTokens(spokenText(agentLines))) {
    const t = token.replace(/^['"-]+|['"-]+$/g, "");
    if (!t || BENIGN.has(t)) continue;
    if (t.length < 3 && !/^\d+$/.test(t)) continue;
    if (pool.includes(t)) continue;
    const abbreviation = STATE_ABBREVIATIONS[t];
    if (abbreviation && new RegExp(`\\b${abbreviation}\\b`).test(pool)) continue;
    // A number the agent spoke digit by digit is the same number the config
    // stores unspaced.
    if (/^\d+$/.test(t) && poolDigits.includes(t)) continue;
    const line = agentLines.find((l) => l.toLowerCase().includes(t)) ?? "";
    // `t`, not the raw token: the question must quote the same value the
    // grounding failed on, or it asks about something never said.
    out.push({ token: t, line: line.slice(0, 220) });
    if (out.length >= max) break;
  }
  return out;
}

export interface HallucinationState {
  node_instructions_full: string;
  global_prompt: string;
  agent_persona_and_scripted_lines_from_config: string[];
  global_variables: Record<string, string>;
  tool_results: string[];
  caller_said: string[];
  agent_spoken: string[];
}

/**
 * The compact grounded state the H1-H4 questions read. Config is never cut:
 * when the state is over budget the evidence lists shed (tool results first,
 * then config excerpts, then caller lines) — the node prompt and the agent's
 * own spoken lines, which are the subject of the judgement, always survive.
 */
export function buildHallucinationState(
  call: ConversationInput,
  node: NodeEvalInput,
  transcript: string,
  budgetTokens: number,
): { state: HallucinationState; agentLines: string[] } {
  const clipped = clipToolResults(transcript);
  const agentLines = transcriptLines(clipped, ["Agent:"]);
  const state: HallucinationState = {
    node_instructions_full: node.node_prompt ?? "",
    global_prompt: call.global_prompt ?? "",
    agent_persona_and_scripted_lines_from_config: configExcerpts(call, agentLines),
    global_variables: call.global_variables ?? {},
    tool_results: transcriptLines(clipped, ["Tool_Call:", "Tool_Result:"]).map((l) => l.slice(0, 1500)),
    caller_said: transcriptLines(clipped, ["User:"]).map((l) => l.slice(0, LINE_CHARS)),
    agent_spoken: agentLines.map((l) => l.slice(0, LINE_CHARS)),
  };
  // Shed the bulkiest evidence first. There is deliberately no rung that drops
  // tool results entirely: "was this claim backed by a successful tool call?"
  // is unanswerable without them, so a state that still does not fit is better
  // left to the LLM judge (the plan's budget check drops it) than asked blind.
  const shedding: Array<[keyof HallucinationState, number]> = [
    ["tool_results", 12],
    ["agent_persona_and_scripted_lines_from_config", 15],
    ["tool_results", 4],
    ["agent_persona_and_scripted_lines_from_config", 0],
  ];
  for (const [key, keep] of shedding) {
    if (estimateJevTokens(state) <= budgetTokens) break;
    (state[key] as string[]) = (state[key] as string[]).slice(0, keep);
  }
  return { state, agentLines };
}
