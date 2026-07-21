import { describe, test, expect } from "bun:test";
import { renderFullTranscript, renderToolCallLines, normalizeToolCalls } from "../src/evals-engine/conversation-input.js";
import type { EvalTurn } from "../src/evals-engine/types.js";

// Regression coverage for the sim-eval "tool-call blindness" bug: the transcript handed to the LLM
// judges rendered User:/Agent: lines only, dropping the tool calls the agent made. Grounding judges
// (hallucination/loop) then flagged tool-backed actions (DNC / callback / lead-submit) as unsupported.
//
// `renderToolCallLines` is the shared helper used by BOTH renderFullTranscript (conversation-input)
// and renderNodeTranscript (node-judges), so exercising it here covers the node transcript too —
// without importing node-judges (which transitively loads the LLM/config module).

const toolTurn: EvalTurn = {
  node_uuid: "n1",
  user: "Can you call me tomorrow at 2?",
  agent: "I'll note your preference for tomorrow at two.",
  intent: "busy_callback",
  tool_calls: [{ name: "handoff_busy_callback", arguments: "{}", output: null }],
};

const plainTurn: EvalTurn = { node_uuid: "n1", user: "Hello", agent: "Hi there", intent: "" };

describe("renderToolCallLines", () => {
  test("emits Tool_Call with no parens when args are empty/{}", () => {
    expect(renderToolCallLines(toolTurn)).toEqual(["Tool_Call: handoff_busy_callback"]);
  });

  test("shows args when non-empty and Tool_Result only when output present", () => {
    const t: EvalTurn = { ...toolTurn, tool_calls: [{ name: "lookup", arguments: '{"id":1}', output: "found: yes" }] };
    expect(renderToolCallLines(t)).toEqual(['Tool_Call: lookup({"id":1})', "Tool_Result: lookup -> found: yes"]);
  });

  test("no tool_calls -> no lines", () => {
    expect(renderToolCallLines(plainTurn)).toEqual([]);
  });
});

describe("renderFullTranscript surfaces tool calls to the judges", () => {
  test("emits a Tool_Call line after the agent turn", () => {
    const out = renderFullTranscript([toolTurn]);
    expect(out).toBe("User: Can you call me tomorrow at 2?\nAgent: I'll note your preference for tomorrow at two.\nTool_Call: handoff_busy_callback");
  });

  test("no tool calls -> transcript unchanged (User:/Agent: only)", () => {
    expect(renderFullTranscript([plainTurn])).toBe("User: Hello\nAgent: Hi there");
    expect(renderFullTranscript([plainTurn])).not.toContain("Tool_Call");
  });

  test("a silent handoff turn (no agent text) still surfaces its Tool_Call", () => {
    const silent: EvalTurn = { node_uuid: "n1", user: "Yes, go ahead.", agent: "", intent: "", tool_calls: [{ name: "handoff_ready_to_submit_lead" }] };
    expect(renderFullTranscript([silent])).toBe("User: Yes, go ahead.\nTool_Call: handoff_ready_to_submit_lead");
  });
});

describe("normalizeToolCalls (raw sim tool_calls -> EvalToolCall[])", () => {
  test("extracts name/arguments/output and skips nameless entries", () => {
    const raw = [
      { id: "x", name: "handoff_busy_callback", output: null, is_error: false, arguments: "{}" },
      { id: "y", output: null },
    ];
    const norm = normalizeToolCalls(raw);
    expect(norm).toHaveLength(1);
    expect(norm[0]).toEqual({ name: "handoff_busy_callback", arguments: "{}", output: null });
  });

  test("returns [] for non-array / empty input", () => {
    expect(normalizeToolCalls(undefined)).toEqual([]);
    expect(normalizeToolCalls([])).toEqual([]);
    expect(normalizeToolCalls("nope" as unknown)).toEqual([]);
  });
});
