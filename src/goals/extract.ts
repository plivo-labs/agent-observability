/**
 * Pure input-shaping for the goal analyzer: parse goal:<text> tag strings
 * and render a role-labeled transcript from chat_history.
 *
 * Transcript rendering deliberately differs from the search column
 * (migration 018): the LLM needs speakers, so lines are labeled
 * caller:/agent:. Both observed content shapes are handled — string[]
 * fragments AND a plain string (the majority of sampled production rows).
 */

const GOAL_PREFIX = "goal:";
const GOAL_MAX_CHARS = 500;

/** Default transcript budget. Tail-keeping: sessions resolve at the end,
 *  so when over budget the START of the call is dropped. */
export const TRANSCRIPT_MAX_CHARS = 48_000;

export function parseGoalTags(tags: unknown[]): string[] {
  const seen = new Set<string>();
  const goals: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string" || !tag.startsWith(GOAL_PREFIX)) continue;
    const text = tag.slice(GOAL_PREFIX.length).trim().slice(0, GOAL_MAX_CHARS);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    goals.push(text);
  }
  return goals;
}

const ROLE_LABELS: Record<string, string> = {
  user: "caller",
  assistant: "agent",
};

function messageLine(item: Record<string, unknown>): string | null {
  if (item.type !== "message") return null;
  const role = typeof item.role === "string" ? item.role : "unknown";
  const label = ROLE_LABELS[role] ?? role;
  const content = item.content;
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.filter((c): c is string => typeof c === "string").join(" ");
  } else {
    return null;
  }
  text = text.trim();
  if (!text) return null;
  return `${label}: ${text}`;
}

export function renderTranscript(
  chatHistory: unknown,
  maxChars: number = TRANSCRIPT_MAX_CHARS,
): { text: string; truncated: boolean } {
  if (!Array.isArray(chatHistory)) return { text: "", truncated: false };

  const lines: string[] = [];
  for (const item of chatHistory) {
    if (item && typeof item === "object") {
      const line = messageLine(item as Record<string, unknown>);
      if (line) lines.push(line);
    }
  }

  const full = lines.join("\n");
  if (full.length <= maxChars) return { text: full, truncated: false };

  // Drop whole lines from the head until the tail fits the budget.
  const kept: string[] = [];
  let length = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + (kept.length > 0 ? 1 : 0); // +1 for newline
    if (length + cost > maxChars) break;
    kept.unshift(lines[i]);
    length += cost;
  }
  return { text: kept.join("\n"), truncated: true };
}
