import { describe, test, expect } from "bun:test";

import {
  buildSessionEvalInput,
  type AgentConfig,
} from "../src/evals-engine/integration/session-evals.js";

// Unit tests for the ingest→engine input builder. Pure logic (no LLM): verifies
// node grouping by opaque node_ref, tool/KB evidence rendering, variable-rule
// forwarding, the single-node fallback, and that verdict-order tracks input order.

function cfg(): AgentConfig {
  return {
    flow_name: "Support",
    global_prompt: "Be helpful.",
    goals: [{ name: "Resolved", instructions: "Issue resolved" }, { name: "", instructions: "dropped" }],
    nodes: [
      {
        ref: "node-A",
        name: "Greeter",
        instructions: "Greet and collect the name.",
        intents: [{ name: "Done", description: "finished" }],
        variables: [{ name: "caller_name", rule: "as stated" }, { name: "callback" }],
      },
      { ref: "node-B", name: "Closer", instructions: "Wrap up." },
    ],
  };
}

function ev(node_ref: string | undefined, role: string, text: string) {
  return { type: "conversation_item_added", node_ref, item: { type: "message", role, content: text } };
}

describe("buildSessionEvalInput", () => {
  test("groups turns by node_ref and maps config, in order", () => {
    const { input, nodeRefs } = buildSessionEvalInput(cfg(), [
      ev("node-A", "assistant", "Hi, your name?"),
      ev("node-A", "user", "Alex"),
      ev("node-B", "assistant", "Thanks, bye"),
    ]);
    expect(input.flow_name).toBe("Support");
    expect(input.global_prompt).toBe("Be helpful.");
    expect(input.nodes.map((n) => n.node_uuid)).toEqual(["node-A", "node-B"]);
    expect(nodeRefs.map((r) => r.ref)).toEqual(["node-A", "node-B"]);

    const a = input.nodes[0];
    expect(a.node_name).toBe("Greeter");
    expect(a.node_prompt).toBe("Greet and collect the name.");
    expect(a.required_variables).toEqual(["caller_name", "callback"]);
    expect(a.variable_rules).toEqual({ caller_name: "as stated" }); // rule-less var omitted
    expect(a.turn_count).toBe(2);
  });

  test("renders tool call + result as labelled evidence lines (not dropped)", () => {
    const { input } = buildSessionEvalInput(cfg(), [
      ev("node-A", "user", "How much did I spend?"),
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "function_call", name: "spend", arguments: { year: 2026 } } },
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "function_call_output", name: "spend", output: { total: "$1,234" } } },
      ev("node-A", "assistant", "You spent $1,234."),
    ]);
    const agentTurns = input.nodes[0].turns.map((t) => t.agent).filter(Boolean);
    expect(agentTurns).toContain('Tool_Call: spend({"year":2026})');
    expect(agentTurns).toContain('Tool_Result: spend -> {"total":"$1,234"}');
    expect(input.nodes[0].turn_count).toBe(4);
  });

  test("falls back to the first node when the transcript carries no node_ref", () => {
    const { input } = buildSessionEvalInput(cfg(), [
      ev(undefined, "assistant", "Hello"),
      ev(undefined, "user", "Hi"),
    ]);
    expect(input.nodes).toHaveLength(1);
    expect(input.nodes[0].node_uuid).toBe("node-A");
    expect(input.nodes[0].turn_count).toBe(2);
  });

  test("drops nameless goals; keeps valid ones", () => {
    const { input } = buildSessionEvalInput(cfg(), [ev("node-A", "user", "hi")]);
    expect(input.goals).toEqual([{ goal_name: "Resolved", goal_instructions: "Issue resolved", flow_goal_id: 0 }]);
  });

  test("nodes with no turns are excluded; empty inputs never throw", () => {
    // node-B configured but never spoken → excluded
    const { input } = buildSessionEvalInput(cfg(), [ev("node-A", "user", "hi")]);
    expect(input.nodes.map((n) => n.node_uuid)).toEqual(["node-A"]);
    expect(buildSessionEvalInput({}, []).input.nodes).toEqual([]);
    expect(buildSessionEvalInput({ nodes: [] }, []).input.nodes).toEqual([]);
  });

  test("renders full transcript in chronological order", () => {
    const { input } = buildSessionEvalInput(cfg(), [
      ev("node-A", "assistant", "Q?"),
      ev("node-A", "user", "A"),
    ]);
    expect(input.full_transcript).toBe(["Agent: Q?", "User: A"].join("\n"));
  });
});
