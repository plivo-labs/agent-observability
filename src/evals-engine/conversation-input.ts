import type { FlowGraph } from "../sim-engine/run-engine/flow-types.js";
import type { ConversationInput, EvalTurn, GoalInput, NodeEvalInput } from "./types.js";

// AO Eval Engine — build the eval input from a simulation run. Mirrors cx-sqs's transcript_builder.go:
// group the turn log by node, and for each AI node collect the config (instructions / intents /
// extract_variables) + the turns that ran there + the variables extracted. Goals come from the flow's
// `agent_settings.conversation_goals` (tolerant read; absent → empty → goal axis skipped).

/** flow `systemPrompt` is either a string or `{ prompt, … }`. Read the prompt text defensively. */
function readGlobalPrompt(flowObj: Record<string, unknown>): string {
  const sp = flowObj.systemPrompt ?? flowObj.system_prompt;
  if (typeof sp === "string") return sp;
  if (sp && typeof sp === "object") {
    const p = (sp as Record<string, unknown>).prompt;
    if (typeof p === "string") return p;
  }
  return "";
}

/** Tolerant read of `agent_settings.conversation_goals` (either camel/snake key). */
function readGoals(flowObj: Record<string, unknown>): GoalInput[] {
  const settings = (flowObj.agentSettings ?? flowObj.agent_settings) as Record<string, unknown> | undefined;
  const raw = settings?.conversation_goals;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((g): GoalInput | null => {
      if (!g || typeof g !== "object") return null;
      const o = g as Record<string, unknown>;
      const name = typeof o.goal_name === "string" ? o.goal_name : "";
      if (!name) return null;
      return {
        goal_name: name,
        goal_instructions: typeof o.goal_instructions === "string" ? o.goal_instructions : "",
        flow_goal_id: typeof o.flow_goal_id === "number" ? o.flow_goal_id : Number(o.flow_goal_id) || 0,
      };
    })
    .filter((g): g is GoalInput => g !== null);
}

function requiredVariables(config: Record<string, unknown> | null): string[] {
  const ev = config?.extract_variables;
  if (!Array.isArray(ev)) return [];
  return ev
    .map((v) => (v && typeof v === "object" ? (v as Record<string, unknown>).variable_name : undefined))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

function availableIntents(config: Record<string, unknown> | null): unknown[] {
  const intents = config?.intents;
  return Array.isArray(intents) ? intents : [];
}

/** Render the whole conversation as "User: …\nAgent: …" lines (context for hallucination/loop/goal). */
export function renderFullTranscript(turns: EvalTurn[]): string {
  const lines: string[] = [];
  for (const t of turns) {
    if (t.user) lines.push(`User: ${t.user}`);
    if (t.agent) lines.push(`Agent: ${t.agent}`);
  }
  return lines.join("\n");
}

export interface FromSimTranscriptArgs {
  turns: EvalTurn[];
  graph: FlowGraph;
  flowObj: Record<string, unknown>;
  variablesByNode: Record<string, Record<string, unknown>>;
}

export function fromSimTranscript({ turns, graph, flowObj, variablesByNode }: FromSimTranscriptArgs): ConversationInput {
  // Group turns by node, preserving first-seen order.
  const order: string[] = [];
  const byNode = new Map<string, EvalTurn[]>();
  for (const t of turns) {
    if (!byNode.has(t.node_uuid)) {
      byNode.set(t.node_uuid, []);
      order.push(t.node_uuid);
    }
    byNode.get(t.node_uuid)!.push(t);
  }

  const nodes: NodeEvalInput[] = order.map((nodeUuid) => {
    const nodeTurns = byNode.get(nodeUuid)!;
    const gnode = graph.nodes.get(nodeUuid);
    const config = gnode?.config ?? null;
    const chosen = [...nodeTurns].reverse().find((t) => t.intent)?.intent ?? "";
    return {
      node_uuid: nodeUuid,
      node_name: gnode?.configName || gnode?.metaName || nodeUuid,
      node_prompt: typeof config?.instructions === "string" ? config.instructions : "",
      available_intents: availableIntents(config),
      chosen_intent: chosen,
      required_variables: requiredVariables(config),
      extracted_variables: variablesByNode[nodeUuid] ?? {},
      turns: nodeTurns,
      turn_count: nodeTurns.length,
    };
  });

  return {
    flow_name: typeof flowObj.flow_name === "string" ? flowObj.flow_name : "simulation",
    global_prompt: readGlobalPrompt(flowObj),
    nodes,
    goals: readGoals(flowObj),
    full_transcript: renderFullTranscript(turns),
  };
}
