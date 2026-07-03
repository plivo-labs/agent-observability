/**
 * Pure-function tests for the goal analyzer's input shaping: parsing
 * goal:<text> tag strings and rendering a role-labeled transcript from
 * chat_history. No db, no LLM — these are the deterministic edges.
 */
import { describe, test, expect } from "bun:test";
import { parseGoalTags, renderTranscript } from "../src/goals/extract.js";

describe("parseGoalTags", () => {
  test("splits goal:<name>:<description> at the first colon after the prefix", () => {
    expect(
      parseGoalTags(["goal:order-resolution:Resolve the caller's order issue or open a ticket"]),
    ).toEqual([
      { name: "order-resolution", description: "Resolve the caller's order issue or open a ticket" },
    ]);
  });

  test("name-only goals self-describe (description = name)", () => {
    expect(parseGoalTags(["goal:identity-check"])).toEqual([
      { name: "identity-check", description: "identity-check" },
    ]);
  });

  test("description keeps colons after the name separator", () => {
    expect(parseGoalTags(["goal:escalation:Escalate: only after two failed attempts"])).toEqual([
      { name: "escalation", description: "Escalate: only after two failed attempts" },
    ]);
  });

  test("trims both parts", () => {
    expect(parseGoalTags(["goal: refund : Issue a refund when asked "])).toEqual([
      { name: "refund", description: "Issue a refund when asked" },
    ]);
  });

  test("ignores non-goal tags", () => {
    expect(
      parseGoalTags(["account_id:acct-1", "agent_id:a-1", "goal:identity:Confirm identity", "lk.success"]),
    ).toEqual([{ name: "identity", description: "Confirm identity" }]);
  });

  test("dedupes by name preserving first-occurrence order", () => {
    expect(parseGoalTags(["goal:b:first b", "goal:a:the a", "goal:b:second b"])).toEqual([
      { name: "b", description: "first b" },
      { name: "a", description: "the a" },
    ]);
  });

  test("drops goals whose name is empty after trimming", () => {
    expect(parseGoalTags(["goal:", "goal:   ", "goal::only description", "goal:real:desc"])).toEqual([
      { name: "real", description: "desc" },
    ]);
  });

  test("caps name at 100 and description at 500 characters", () => {
    const longName = "n".repeat(150);
    const longDesc = "d".repeat(600);
    const [parsed] = parseGoalTags([`goal:${longName}:${longDesc}`]);
    expect(parsed.name).toHaveLength(100);
    expect(parsed.description).toHaveLength(500);
  });

  test("tolerates non-string entries", () => {
    expect(
      parseGoalTags([42 as unknown as string, null as unknown as string, "goal:ok:fine"]),
    ).toEqual([{ name: "ok", description: "fine" }]);
  });
});

describe("renderTranscript", () => {
  const msg = (role: string, content: unknown) => ({ type: "message", role, content });

  test("labels user as caller and assistant as agent, one line per message", () => {
    const { text, truncated } = renderTranscript([
      msg("assistant", ["Hi, thanks for calling."]),
      msg("user", ["I want a refund."]),
    ]);
    expect(text).toBe("agent: Hi, thanks for calling.\ncaller: I want a refund.");
    expect(truncated).toBe(false);
  });

  test("handles plain-string content (the non-array shape)", () => {
    const { text } = renderTranscript([msg("user", "Plain string here.")]);
    expect(text).toBe("caller: Plain string here.");
  });

  test("joins multi-fragment content arrays with a space", () => {
    const { text } = renderTranscript([msg("assistant", ["First.", "Second."])]);
    expect(text).toBe("agent: First. Second.");
  });

  test("skips non-message items", () => {
    const { text } = renderTranscript([
      msg("user", ["Is it in stock?"]),
      { type: "function_call", name: "check_stock", arguments: "{}" },
      { type: "function_call_output", output: "42 in stock" },
      { type: "agent_handoff", new_agent: "inventory" },
      msg("assistant", ["Yes."]),
    ]);
    expect(text).toBe("caller: Is it in stock?\nagent: Yes.");
  });

  test("keeps unknown roles labeled verbatim", () => {
    const { text } = renderTranscript([msg("system", ["Be brief."])]);
    expect(text).toBe("system: Be brief.");
  });

  test("returns empty for null or non-array input", () => {
    expect(renderTranscript(null)).toEqual({ text: "", truncated: false });
    expect(renderTranscript({ not: "an array" })).toEqual({ text: "", truncated: false });
  });

  test("truncates from the head, keeping the tail within the budget", () => {
    const items = Array.from({ length: 100 }, (_, i) => msg("user", [`message number ${i} padding padding`]));
    const { text, truncated } = renderTranscript(items, 500);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(500);
    // The END of the conversation must survive — sessions resolve at the end.
    expect(text).toContain("message number 99");
    expect(text).not.toContain("message number 0 ");
    // Cut on a line boundary: first line is a complete labeled line.
    expect(text.startsWith("caller: ")).toBe(true);
  });
});
