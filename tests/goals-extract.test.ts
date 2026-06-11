/**
 * Pure-function tests for the goal analyzer's input shaping: parsing
 * goal:<text> tag strings and rendering a role-labeled transcript from
 * chat_history. No db, no LLM — these are the deterministic edges.
 */
import { describe, test, expect } from "bun:test";
import { parseGoalTags, renderTranscript } from "../src/goals/extract.js";

describe("parseGoalTags", () => {
  test("strips the goal: prefix and trims whitespace", () => {
    expect(parseGoalTags(["goal: Resolve the order issue "])).toEqual([
      "Resolve the order issue",
    ]);
  });

  test("ignores non-goal tags", () => {
    expect(
      parseGoalTags(["account_id:acct-1", "agent_id:a-1", "goal:Confirm identity", "lk.success"]),
    ).toEqual(["Confirm identity"]);
  });

  test("preserves colons inside the goal text", () => {
    expect(parseGoalTags(["goal:Escalate: only after two failed attempts"])).toEqual([
      "Escalate: only after two failed attempts",
    ]);
  });

  test("dedupes preserving first-occurrence order", () => {
    expect(parseGoalTags(["goal:b", "goal:a", "goal:b"])).toEqual(["b", "a"]);
  });

  test("drops goals that are empty after trimming", () => {
    expect(parseGoalTags(["goal:", "goal:   ", "goal:real"])).toEqual(["real"]);
  });

  test("caps each goal at 500 characters", () => {
    const long = "x".repeat(600);
    const [parsed] = parseGoalTags([`goal:${long}`]);
    expect(parsed).toHaveLength(500);
  });

  test("tolerates non-string entries", () => {
    expect(parseGoalTags([42 as unknown as string, null as unknown as string, "goal:ok"])).toEqual([
      "ok",
    ]);
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
