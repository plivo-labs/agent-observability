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

  test("fills extracted_variables from the variable's declared recording tool", () => {
    const config: AgentConfig = {
      nodes: [{
        ref: "node-A",
        name: "Booking",
        variables: [
          { name: "patient_name", rule: "as stated", tool: "record_patient_name" },
          { name: "visit_type", tool: "record_visit_type" },
          { name: "missing_one", tool: "record_missing_one" },
        ],
      }],
    };
    const { input } = buildSessionEvalInput(config, [
      ev("node-A", "user", "I am Alex, here for a cleaning"),
      // string-serialized arguments (how Python workers send them)
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "function_call", name: "record_patient_name", arguments: '{"value": "Alex"}' } },
      // object arguments with multiple keys → kept whole
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "function_call", name: "record_visit_type", arguments: { value: "cleaning", source: "user" } } },
      // unrelated tool never counts as an extraction
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "function_call", name: "check_availability", arguments: { day: "Tue" } } },
    ]);
    expect(input.nodes[0].extracted_variables).toEqual({
      patient_name: "Alex",
      visit_type: { value: "cleaning", source: "user" },
    });
    // string args render parsed (not double-encoded) in the evidence line
    const agentTurns = input.nodes[0].turns.map((t) => t.agent).filter(Boolean);
    expect(agentTurns).toContain('Tool_Call: record_patient_name({"value":"Alex"})');
  });

  test("derives chosen_intent from the intent's declared tool; handoffs render as evidence", () => {
    const config: AgentConfig = {
      nodes: [{
        ref: "node-A",
        name: "Booking",
        intents: [
          { name: "Booked", description: "confirmed", tool: "handoff_booked" },
          { name: "Declined", description: "caller declines", tool: "handoff_declined" },
        ],
      }],
    };
    const { input } = buildSessionEvalInput(config, [
      ev("node-A", "user", "yes book it"),
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "function_call", name: "handoff_booked", arguments: "{}" } },
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "agent_handoff", name: "closing-agent" } },
    ]);
    expect(input.nodes[0].chosen_intent).toBe("Booked");
    const agentTurns = input.nodes[0].turns.map((t) => t.agent).filter(Boolean);
    expect(agentTurns).toContain("Agent_Handoff: closing-agent");
  });

  test("system-role messages render as truncated System_Note lines, not agent speech", () => {
    const { input } = buildSessionEvalInput(cfg(), [
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "system", content: "x".repeat(700) } },
      ev("node-A", "assistant", "Hi!"),
    ]);
    const agentTurns = input.nodes[0].turns.map((t) => t.agent).filter(Boolean);
    expect(agentTurns[0]!.startsWith("System_Note: ")).toBe(true);
    expect(agentTurns[0]!.length).toBeLessThanOrEqual("System_Note: ".length + 601);
    expect(agentTurns[1]).toBe("Hi!");
  });

  test("speech_transcript drops evidence lines; variables credit cross-node recording calls", () => {
    const config: AgentConfig = {
      nodes: [
        { ref: "visit-1", name: "Booking", variables: [{ name: "patient_name", tool: "record_patient_name" }] },
        { ref: "visit-2", name: "Booking", variables: [{ name: "patient_name", tool: "record_patient_name" }] },
      ],
    };
    const { input } = buildSessionEvalInput(config, [
      ev("visit-1", "user", "I am Alex"),
      { type: "conversation_item_added", node_ref: "visit-1", item: { type: "function_call", name: "record_patient_name", arguments: '{"value": "Alex"}' } },
      { type: "conversation_item_added", node_ref: "visit-2", item: { type: "message", role: "system", content: "internal steering note" } },
      ev("visit-2", "user", "back again"),
    ]);
    // Revisit (visit-2) credits the variable recorded during visit-1 —
    // re-recording is not required, so it must not read as missing.
    expect(input.nodes[1].extracted_variables).toEqual({ patient_name: "Alex" });
    // Speech-only transcript excludes Tool_Call + System_Note lines but the
    // full transcript keeps them.
    expect(input.full_transcript).toContain("Tool_Call: record_patient_name");
    expect(input.full_transcript).toContain("System_Note:");
    expect(input.speech_transcript).not.toContain("Tool_Call:");
    expect(input.speech_transcript).not.toContain("System_Note:");
    expect(input.speech_transcript).toContain("User: I am Alex");
  });

  test("full transcript stays chronological across node revisits", () => {
    const config: AgentConfig = {
      nodes: [{ ref: "node-A", name: "A" }, { ref: "node-B", name: "B" }],
    };
    const { input } = buildSessionEvalInput(config, [
      ev("node-A", "user", "first"),
      ev("node-B", "user", "second"),
      ev("node-A", "user", "third"),
    ]);
    const order = input.full_transcript.split("\n").filter((l) => l.startsWith("User:"));
    expect(order).toEqual(["User: first", "User: second", "User: third"]);
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

  test("tags agent turns matching config idle_messages as [system idle prompt]", () => {
    const config: AgentConfig = {
      ...cfg(),
      // Punctuation/case/whitespace drift between config and TTS transcript
      // must not break the match.
      idle_messages: [
        "Are you still there? I'm happy to assist whenever you're ready.",
        "Since I'm not hearing a response, I'll go ahead and disconnect",
      ],
    };
    const { input } = buildSessionEvalInput(config, [
      ev("node-A", "user", "hello"),
      ev("node-A", "assistant", "are you still there?  I'm happy to assist whenever you're ready"),
      ev("node-A", "assistant", "Are you still there? I'm happy to assist whenever you're ready."),
      // ASR often inserts a space before terminal punctuation — must still match.
      ev("node-A", "assistant", "Are you still there ? I'm happy to assist whenever you're ready ."),
      ev("node-A", "assistant", "Since I'm not hearing a response, I'll go ahead and disconnect."),
      ev("node-A", "assistant", "Your balance is due."),
    ]);
    const agents = input.nodes[0].turns.map((t) => t.agent).filter(Boolean);
    expect(agents[0]).toContain("[system idle prompt]");
    expect(agents[1]).toContain("[system idle prompt]");
    expect(agents[2]).toContain("[system idle prompt]");
    expect(agents[3]).toContain("[system idle prompt]");
    expect(agents[4]).toBe("Your balance is due."); // real speech untouched
  });

  test("idle_messages text match never tags user turns; malformed idle_messages never throws", () => {
    const config: AgentConfig = { ...cfg(), idle_messages: ["Are you still there?"] };
    const { input } = buildSessionEvalInput(config, [
      ev("node-A", "user", "Are you still there?"), // user echoing the line stays untagged
      ev("node-A", "assistant", "Are you still there?"),
    ]);
    expect(input.nodes[0].turns[0].user).toBe("Are you still there?");
    expect(input.nodes[0].turns[1].agent).toContain("[system idle prompt]");
    // Garbage shapes are ignored, not fatal — AND produce no tagging: a bare
    // string ("reminder") is not a list, and pure-punctuation entries normalize
    // to "" which must not match punctuation-only agent turns.
    for (const bad of [42, "reminder", { msg: "x" }, [null, 7, "", "..."]]) {
      const { input: built } = buildSessionEvalInput(
        { ...cfg(), idle_messages: bad },
        [ev("node-A", "assistant", "reminder"), ev("node-A", "assistant", "?!")],
      );
      for (const t of built.nodes[0].turns) expect(t.agent).not.toContain("[system idle prompt]");
    }
  });

  test("per-item system_idle flag still tags without config idle_messages", () => {
    const { input } = buildSessionEvalInput(cfg(), [
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "assistant", content: "Still there?", system_idle: true } },
    ]);
    expect(input.nodes[0].turns[0].agent).toBe("Still there? [system idle prompt]");
  });
});
