import { describe, test, expect } from "bun:test";
import { estimateJevTokens, clipToolResults, TOOL_RESULT_CLIP_CHARS } from "../src/jev/tokens.js";

describe("estimateJevTokens", () => {
  test("transcript-like fields are estimated at the higher rate", () => {
    const text = "x".repeat(1000);
    const transcript = estimateJevTokens({ conversation_history: text });
    const config = estimateJevTokens({ node_prompt: text });
    expect(transcript).toBeGreaterThan(config);
    expect(transcript).toBeGreaterThanOrEqual(350);
    expect(config).toBeGreaterThanOrEqual(250);
  });

  test("a bare-string state is a transcript, so it takes the transcript rate", () => {
    const text = "x".repeat(1000);
    expect(estimateJevTokens(text)).toBe(350);
    expect(estimateJevTokens(text)).toBeGreaterThan(estimateJevTokens({ node_prompt: text }) - 60);
    expect(estimateJevTokens(null)).toBeGreaterThanOrEqual(0);
  });
});

describe("clipToolResults", () => {
  test("clips only over-long Tool_Result lines and marks the cut", () => {
    const long = "Tool_Result: lookup -> " + "{\"a\":1}".repeat(1000);
    const t = ["User: hi", "Agent: hello", long, "Tool_Call: x({})", "Agent: bye"].join("\n");
    const out = clipToolResults(t).split("\n");
    expect(out).toHaveLength(5);
    expect(out[0]).toBe("User: hi");
    expect(out[2]!.length).toBeLessThan(TOOL_RESULT_CLIP_CHARS + 40);
    expect(out[2]).toContain("[tool output clipped]");
    expect(out[3]).toBe("Tool_Call: x({})");
    expect(out[4]).toBe("Agent: bye");
  });

  test("never touches spoken turns, however long", () => {
    const turn = "User: " + "word ".repeat(2000);
    expect(clipToolResults(turn)).toBe(turn);
  });
});
