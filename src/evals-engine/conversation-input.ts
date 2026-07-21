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

function serializeEvidenceValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function serializeToolArguments(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  return typeof value === "string" ? value : serializeEvidenceValue(value);
}

/** Convert the tool calls carried by a simulation turn into the same labelled,
 *  non-speech evidence understood by the live-session judges. */
function renderToolEvidence(toolCalls: unknown[] | undefined): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const lines: string[] = [];
  for (const raw of toolCalls) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const call = raw as Record<string, unknown>;
    const name = typeof call.name === "string" ? call.name.trim() : "";
    if (!name) continue;
    lines.push(`Tool_Call: ${name}(${serializeToolArguments(call.arguments)})`);
    if (Object.prototype.hasOwnProperty.call(call, "output") && call.output !== null && call.output !== undefined) {
      lines.push(`Tool_Result: ${name} -> ${serializeEvidenceValue(call.output)}`);
    }
  }
  return lines;
}

/** Render turns for node and full-conversation judge context.
 *
 * Evidence turns render bare because Tool_Call:/Tool_Result:/System_Note:/
 * Agent_Handoff: are runtime events, not words the agent spoke. They remain in
 * the transcript as grounding and intent evidence. This is the single home for
 * the evidence-rendering rule so node_transcript and conversation_history cannot
 * drift into different speaker attribution.
 */
export function renderFullTranscript(turns: EvalTurn[]): string {
  const lines: string[] = [];
  for (const t of turns) {
    if (t.user) lines.push(`User: ${t.user}`);
    lines.push(...renderToolEvidence(t.tool_calls));
    if (t.agent) lines.push(t.evidence ? t.agent : `Agent: ${t.agent}`);
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
