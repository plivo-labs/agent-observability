import { describe, test, expect } from "bun:test";

import {
  fromCxConversationInput,
  buildCxEvalInput,
  type CxConversationInput,
} from "../src/evals-engine/integration/cx-redirect.js";

// Unit tests for the cx-sqs-worker → eval-engine input adapter. Pure logic (no LLM):
// verifies node filtering, per-speaker→paired-turn conversion, variable/intent/goal
// mapping, and transcript rendering.

function baseInput(): CxConversationInput {
  return {
    flow_definition: {
      flow_uuid: "flow-1",
      flow_name: "Support Flow",
      global_prompt: "Be concise and kind.",
      nodes: {
        "start-node": { prompt: "" }, // non-AI, will be skipped by node_type
        "ai-node": {
          prompt: "Greet the caller and collect their name.",
          intents: [{ intent_name: "Not Interested" }, { intent_name: "Continue" }],
          extract_variables: [{ variable_name: "caller_name" }, { variable_name: "callback_time" }],
        },
      },
      goals: [
        { id: 7, goal_name: "Confirm identity", goal_instructions: "Verify the caller is the right party." },
        { goal_name: "", goal_instructions: "ignored — no name" }, // dropped
      ],
    },
    flow_run: {
      channel: "voice",
      run_uuid: "run-1",
      node_run_history: [
        {
          node_uuid: "start-node",
          node_type: "start",
          node_name: "Start",
          data: { turns: [{ speaker: "bot", message: "connecting" }] },
        },
        {
          node_uuid: "ai-node",
          node_type: "ai_agent_v2",
          node_name: "Greeter",
          chosen_intent: "Not Interested",
          data: {
            turns: [
              { speaker: "system", message: "idle reminder", is_system_message: true }, // dropped
              { speaker: "bot", message: "Hi, who am I speaking with?" },
              { speaker: "user", message: "This is Alex.", variables: { caller_name: "Alex" } },
              { speaker: "bot", message: "Thanks Alex. When can we call back?" },
              { speaker: "user", message: "Now is fine.", variables: { callback_time: "now" } },
              { speaker: "user", message: "Actually, no.", variables: { callback_time: "" } }, // empty val ignored
            ],
          },
        },
      ],
    },
  };
}

describe("fromCxConversationInput", () => {
  test("maps a cx payload to the engine ConversationInput", () => {
    const out = fromCxConversationInput(baseInput());

    expect(out.flow_name).toBe("Support Flow");
    expect(out.global_prompt).toBe("Be concise and kind.");

    // Only the AI node survives (start node skipped by node_type).
    expect(out.nodes).toHaveLength(1);
    const node = out.nodes[0];
    expect(node.node_uuid).toBe("ai-node");
    expect(node.node_name).toBe("Greeter");
    expect(node.node_prompt).toBe("Greet the caller and collect their name.");
    expect(node.chosen_intent).toBe("Not Interested");
    expect(node.required_variables).toEqual(["caller_name", "callback_time"]);
    // Empty-valued variable is dropped; the rest union across turns.
    expect(node.extracted_variables).toEqual({ caller_name: "Alex", callback_time: "now" });
  });

  test("converts per-speaker turns one-per-utterance in order (system turns dropped)", () => {
    const out = fromCxConversationInput(baseInput());
    const turns = out.nodes[0].turns;

    // one one-sided EvalTurn per utterance, chronological (agent greets first).
    expect(turns).toEqual([
      { node_uuid: "ai-node", user: "", agent: "Hi, who am I speaking with?", intent: "" },
      { node_uuid: "ai-node", user: "This is Alex.", agent: "", intent: "" },
      { node_uuid: "ai-node", user: "", agent: "Thanks Alex. When can we call back?", intent: "" },
      { node_uuid: "ai-node", user: "Now is fine.", agent: "", intent: "" },
      { node_uuid: "ai-node", user: "Actually, no.", agent: "", intent: "" },
    ]);
    expect(out.nodes[0].turn_count).toBe(5);
  });

  test("renders the full transcript in exact chronological order", () => {
    const out = fromCxConversationInput(baseInput());
    expect(out.full_transcript).toBe(
      [
        "Agent: Hi, who am I speaking with?",
        "User: This is Alex.",
        "Agent: Thanks Alex. When can we call back?",
        "User: Now is fine.",
        "User: Actually, no.",
      ].join("\n"),
    );
  });

  test("collects nodeRefs (node_run_uuid/node_run_key) parallel to nodes for the console to match", () => {
    const input = baseInput();
    input.flow_run!.node_run_history![1].node_run_uuid = "run-node-abc";
    input.flow_run!.node_run_history![1].node_run_key = "2";
    const { input: engineInput, nodeRefs } = buildCxEvalInput(input);
    expect(engineInput.nodes).toHaveLength(1);
    expect(nodeRefs).toHaveLength(1); // parallel to nodes (start node excluded from both)
    expect(nodeRefs[0]).toEqual({ node_run_uuid: "run-node-abc", node_run_key: "2" });
  });

  test("maps goals and drops nameless ones", () => {
    const out = fromCxConversationInput(baseInput());
    expect(out.goals).toEqual([
      { goal_name: "Confirm identity", goal_instructions: "Verify the caller is the right party.", flow_goal_id: 7 },
    ]);
  });

  test("empty / malformed payloads yield an empty input, never throw", () => {
    expect(fromCxConversationInput({}).nodes).toEqual([]);
    expect(fromCxConversationInput({ flow_run: { node_run_history: [] } }).nodes).toEqual([]);
    // node present but no matching definition → skipped
    const orphan: CxConversationInput = {
      flow_definition: { nodes: {} },
      flow_run: { node_run_history: [{ node_uuid: "x", node_type: "ai_agent_v2", data: { turns: [{ speaker: "user", message: "hi" }] } }] },
    };
    expect(fromCxConversationInput(orphan).nodes).toEqual([]);
  });

  test("node with only system/empty turns is excluded", () => {
    const input: CxConversationInput = {
      flow_definition: { nodes: { n: { prompt: "p" } } },
      flow_run: {
        node_run_history: [
          { node_uuid: "n", node_type: "ai_agent_v2", data: { turns: [{ speaker: "bot", message: "", is_system_message: false }, { speaker: "system", message: "x", is_system_message: true }] } },
        ],
      },
    };
    expect(fromCxConversationInput(input).nodes).toEqual([]);
  });

  test("ai_action (tool) nodes are excluded — Go's evaluator allowlists ai_agent_v2 only", () => {
    const input: CxConversationInput = {
      flow_definition: { nodes: { act: { prompt: "" }, ai: { prompt: "p" } } },
      flow_run: {
        node_run_history: [
          {
            node_uuid: "act",
            node_type: "ai_action",
            data: { turns: [{ speaker: "bot", message: "Order looked up.", tool_calls: ["lookup_order → {status: shipped}"] }] },
          },
          { node_uuid: "ai", node_type: "ai_agent_v2", data: { turns: [{ speaker: "user", message: "hi" }] } },
        ],
      },
    };
    const out = fromCxConversationInput(input);
    expect(out.nodes.map((n) => n.node_uuid)).toEqual(["ai"]);
  });

  test("assistant turns keep tool/KB evidence; tool-only turns get the placeholder", () => {
    const input: CxConversationInput = {
      flow_definition: { nodes: { n: { prompt: "p" } } },
      flow_run: {
        node_run_history: [
          {
            node_uuid: "n",
            node_type: "ai_agent_v2",
            data: {
              turns: [
                // tool-output-only turn: previously dropped, now kept with the Go placeholder
                { speaker: "bot", message: "", tool_calls: ["overall_spend_summary → {total: 4200}"] },
                {
                  speaker: "bot",
                  message: "Your total spend is 4,200.",
                  tool_calls: ["get_currency → INR"],
                  kb_results: { references: [{ chunks: [{ content: "Spend policy chunk." }] }] },
                },
                { speaker: "user", message: "Okay thanks", is_interrupted: true },
              ],
            },
          },
        ],
      },
    };
    const turns = fromCxConversationInput(input).nodes[0].turns;
    expect(turns[0].agent).toBe(
      "[Tool execution results included in response]\nTool_Calls: overall_spend_summary → {total: 4200}",
    );
    expect(turns[1].agent).toBe(
      "Your total spend is 4,200.\nKB_Chunks:\n  [1] Spend policy chunk.\nTool_Calls: get_currency → INR",
    );
    expect(turns[2].user).toBe("Okay thanks [interrupted]");
  });

  test("variable recording rules are forwarded as variable_rules (omitted when absent)", () => {
    const input = baseInput();
    input.flow_definition!.nodes!["ai-node"].extract_variables = [
      { variable_name: "caller_name", variable_instructions: "Full name as stated by the caller." },
      { variable_name: "callback_time" }, // no rule
    ];
    const withRules = fromCxConversationInput(input).nodes[0];
    expect(withRules.required_variables).toEqual(["caller_name", "callback_time"]);
    expect(withRules.variable_rules).toEqual({ caller_name: "Full name as stated by the caller." });

    const noRules = fromCxConversationInput(baseInput()).nodes[0];
    expect(noRules.variable_rules).toBeUndefined();
  });
});
