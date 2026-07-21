/**
 * Live hallucination-judge calibration for simulation tool evidence.
 *
 * The examples are synthetic and PII-free. They preserve the six audited
 * false-positive boundaries plus one true-positive recall control without
 * sending captured simulation transcripts to the model provider.
 *
 * Run with the normal judge provider environment configured:
 *   bun run scripts/sim-tool-evidence-smoke.ts
 *
 * Optional filters:
 *   REPLAY_IDS=17 REPLAY_REPEATS=5 bun run scripts/sim-tool-evidence-smoke.ts
 */
import { renderFullTranscript } from "../src/evals-engine/conversation-input.js";
import { runHallucinationJudge } from "../src/evals-engine/judges/node-judges.js";
import type {
  ConversationInput,
  EvalTurn,
  NodeEvalInput,
} from "../src/evals-engine/types.js";

type BoundaryCase = {
  id: number;
  name: string;
  expectedHallucinated: boolean;
  turns: EvalTurn[];
};

const nodePrompt = [
  "You are a lead qualification agent.",
  "Use handoff_hostile_dnc_request when the caller requests no further contact.",
  "Use handoff_busy_callback after capturing a requested callback time.",
  "Use handoff_ready_to_submit_lead after qualification is complete or when routing the collected lead outcome.",
  "Do not invent factual details.",
].join(" ");

const cases: BoundaryCase[] = [
  {
    id: 2,
    name: "DNC handoff grounds completion language",
    expectedHallucinated: false,
    turns: [{
      node_uuid: "n1",
      user: "Remove me from your list and do not call me again.",
      agent: "Understood. You won't receive further calls.",
      intent: "Hostile DNC Request",
      tool_calls: [{ name: "handoff_hostile_dnc_request", arguments: "{}", output: null }],
    }],
  },
  {
    id: 3,
    name: "callback handoff grounds note language",
    expectedHallucinated: false,
    turns: [{
      node_uuid: "n1",
      user: "Please call tomorrow at two.",
      agent: "I'll note your preference for tomorrow at two.",
      intent: "Busy Callback",
      tool_calls: [{ name: "handoff_busy_callback", arguments: "{}", output: null }],
    }],
  },
  {
    id: 12,
    name: "generic source hedge is not a factual claim",
    expectedHallucinated: false,
    turns: [
      {
        node_uuid: "n1",
        user: "Where did my request come from?",
        agent: "I don't have the exact source. Sometimes requests come through forms or events.",
        intent: "",
      },
      {
        node_uuid: "n1",
        user: "Okay, continue.",
        agent: "Thanks. This qualification call is now complete.",
        intent: "Ready to Submit Lead",
        tool_calls: [{ name: "handoff_ready_to_submit_lead", arguments: "{}", output: null }],
      },
    ],
  },
  {
    id: 13,
    name: "submit handoff grounds completion status",
    expectedHallucinated: false,
    turns: [{
      node_uuid: "n1",
      user: "Yes, that summary is correct.",
      agent: "Thank you. This qualification call is now complete.",
      intent: "Ready to Submit Lead",
      tool_calls: [{ name: "handoff_ready_to_submit_lead", arguments: "{}", output: null }],
    }],
  },
  {
    id: 14,
    name: "handoff grounds workflow acknowledgement",
    expectedHallucinated: false,
    turns: [{
      node_uuid: "n1",
      user: "I am only gathering information and cannot answer more.",
      agent: "Understood. I'll note that you're gathering information.",
      intent: "Ready to Submit Lead",
      tool_calls: [{ name: "handoff_ready_to_submit_lead", arguments: "{}", output: null }],
    }],
  },
  {
    id: 18,
    name: "spoken email verbalization remains grounded",
    expectedHallucinated: false,
    turns: [
      {
        node_uuid: "n1",
        user: "My email is alex.lee@example.com.",
        agent: "Let me confirm: alex dot lee at example dot com.",
        intent: "",
      },
      {
        node_uuid: "n1",
        user: "Correct.",
        agent: "Thank you. The qualification is complete.",
        intent: "Ready to Submit Lead",
        tool_calls: [{ name: "handoff_ready_to_submit_lead", arguments: "{}", output: null }],
      },
    ],
  },
  {
    id: 17,
    name: "unsupported currency remains a true positive",
    expectedHallucinated: true,
    turns: [
      {
        node_uuid: "n1",
        user: "Our budget is around ten thousand.",
        agent: "I have your budget as ten thousand rupees.",
        intent: "",
      },
      {
        node_uuid: "n1",
        user: "No, that is ten thousand dollars.",
        agent: "Thanks for correcting that.",
        intent: "Ready to Submit Lead",
        tool_calls: [{ name: "handoff_ready_to_submit_lead", arguments: "{}", output: null }],
      },
    ],
  },
];

function inputFor(boundary: BoundaryCase): {
  node: NodeEvalInput;
  context: ConversationInput;
} {
  const node: NodeEvalInput = {
    node_uuid: "n1",
    node_name: "Qualify Lead",
    node_prompt: nodePrompt,
    available_intents: [],
    chosen_intent: [...boundary.turns].reverse().find((turn) => turn.intent)?.intent ?? "",
    required_variables: [],
    extracted_variables: {},
    turns: boundary.turns,
    turn_count: boundary.turns.length,
  };
  return {
    node,
    context: {
      flow_name: "PII-free simulation tool-evidence calibration",
      global_prompt: "",
      nodes: [node],
      goals: [],
      full_transcript: renderFullTranscript(boundary.turns),
    },
  };
}

const selectedIds = new Set(
  (process.env.REPLAY_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite),
);
const selectedCases = selectedIds.size === 0
  ? cases
  : cases.filter((item) => selectedIds.has(item.id));
const repeats = Math.max(1, Number(process.env.REPLAY_REPEATS ?? 1) || 1);
const results: Array<{ expected: boolean; actual: boolean; correct: boolean }> = [];

for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const boundary of selectedCases) {
    const { node, context } = inputFor(boundary);
    const { data } = await runHallucinationJudge(node, context);
    const result = {
      expected: boundary.expectedHallucinated,
      actual: data.hallucinated,
      correct: data.hallucinated === boundary.expectedHallucinated,
    };
    results.push(result);
    console.log(JSON.stringify({
      repeat,
      id: boundary.id,
      name: boundary.name,
      expected_hallucinated: result.expected,
      actual_hallucinated: result.actual,
      correct: result.correct,
      reason: data.reason,
    }));
  }
}

const negativeResults = results.filter((result) => result.expected === false);
const positiveResults = results.filter((result) => result.expected === true);
const summary = {
  total: results.length,
  correct: results.filter((result) => result.correct).length,
  false_positive_boundaries_clean: negativeResults.filter((result) => result.actual === false).length,
  false_positive_boundaries_total: negativeResults.length,
  true_positive_controls_retained: positiveResults.filter((result) => result.actual === true).length,
  true_positive_controls_total: positiveResults.length,
};
console.log(JSON.stringify({ summary }));

if (summary.correct !== summary.total) {
  throw new Error(`Simulation tool-evidence calibration failed: ${summary.correct}/${summary.total} correct`);
}
