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
const NAME_MAX_CHARS = 100;
const DESCRIPTION_MAX_CHARS = 500;

/** Default transcript budget. Tail-keeping: sessions resolve at the end,
 *  so when over budget the START of the call is dropped. */
export const TRANSCRIPT_MAX_CHARS = 48_000;

/** A goal as defined in agent code. `name` is the stable identifier
 *  (filterable; stored in session_external_evals.tag), `description` is
 *  what the judge evaluates (stored in instructions). */
export interface GoalSpec {
  name: string;
  description: string;
}

/**
 * Parse `goal:<name>:<description>` tag strings. The split is at the
 * FIRST colon after the prefix — names cannot contain colons,
 * descriptions can. `goal:<name>` alone self-describes (description =
 * name). Deduped by name, first occurrence wins.
 */
export function parseGoalTags(tags: unknown[]): GoalSpec[] {
  const seen = new Set<string>();
  const goals: GoalSpec[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string" || !tag.startsWith(GOAL_PREFIX)) continue;
    const body = tag.slice(GOAL_PREFIX.length);
    const sep = body.indexOf(":");
    const rawName = sep === -1 ? body : body.slice(0, sep);
    const rawDescription = sep === -1 ? body : body.slice(sep + 1);
    const name = rawName.trim().slice(0, NAME_MAX_CHARS);
    if (!name || seen.has(name)) continue;
    const description =
      rawDescription.trim().slice(0, DESCRIPTION_MAX_CHARS) || name;
    seen.add(name);
    goals.push({ name, description });
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
