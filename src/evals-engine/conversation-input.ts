import type { ConversationInput, EvalTurn, GoalInput, NodeEvalInput } from "./types.js";

/** Slim per-node config lookup the judges need, keyed by node_uuid — built from the flow JSON on
 *  the run path. */
export type NodeConfigIndex = ReadonlyMap<
  string,
  { config: Record<string, unknown> | null; configName: string; metaName: string; type?: string }
>;

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
  const names = (list: unknown, key: string): string[] =>
    Array.isArray(list)
      ? list
          .map((v) => (v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined))
          .filter((n): n is string => typeof n === "string" && n.length > 0)
      : [];
  // ai_agent_v2 declares collectibles as extract_variables; agent_node as
  // agent_tasks.variables / agent_tasks.extract_only. Read all three so a
  // collector's genuine captures are judged instead of counting as "extra".
  const tasks = (config?.agent_tasks ?? {}) as Record<string, unknown>;
  return [
    ...names(config?.extract_variables, "variable_name"),
    ...names(tasks.variables, "name"),
    ...names(tasks.extract_only, "name"),
  ];
}

/** The dial half of a screening node is deterministic telephony — its handles are
 *  not LLM choices and must never appear in the judged intent surface. */
const SCREENING_NODE_TYPES = new Set(["outbound_screening", "contact_screening"]);
const DIAL_HANDLES = new Set(["answered", "no_answer", "busy_rejected", "failed", "voicemail_detected"]);

/** A screening node's LLM-driven intent surface: the dispositions actually wired
 *  as outgoing edges (minus the deterministic dial handles). The raw flow config
 *  has no intents[] — agent-runner synthesises them at runtime — so the wired
 *  edges are the eval side's source of truth. */
function screeningIntentsFromEdges(flowObj: Record<string, unknown>, nodeUuid: string): unknown[] {
  const edges = Array.isArray(flowObj.edges) ? (flowObj.edges as Record<string, unknown>[]) : [];
  const handles = new Set<string>();
  for (const e of edges) {
    if (!e || typeof e !== "object" || e.source !== nodeUuid) continue;
    const h = e.sourceHandle;
    if (typeof h === "string" && h && !DIAL_HANDLES.has(h)) handles.add(h);
  }
  return [...handles].map((h) => ({ intent_name: h }));
}

function availableIntents(config: Record<string, unknown> | null): unknown[] {
  const intents = config?.intents;
  return Array.isArray(intents) ? intents : [];
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
    if (t.agent) lines.push(t.evidence ? t.agent : `Agent: ${t.agent}`);
  }
  return lines.join("\n");
}

export interface FromSimTranscriptArgs {
  turns: EvalTurn[];
  nodeIndex: NodeConfigIndex;
  flowObj: Record<string, unknown>;
  variablesByNode: Record<string, Record<string, unknown>>;
}

export function fromSimTranscript({ turns, nodeIndex, flowObj, variablesByNode }: FromSimTranscriptArgs): ConversationInput {
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
    const gnode = nodeIndex.get(nodeUuid);
    const config = gnode?.config ?? null;
    const screening = SCREENING_NODE_TYPES.has(gnode?.type ?? "");
    const chosen =
      [...nodeTurns].reverse().find((t) => t.intent)?.intent ??
      [...nodeTurns].reverse().find((t) => t.exit_handle && !DIAL_HANDLES.has(t.exit_handle))?.exit_handle ??
      "";
    const configIntents = availableIntents(config);
    const extracted = variablesByNode[nodeUuid] ?? {};
    return {
      node_uuid: nodeUuid,
      node_name: gnode?.configName || gnode?.metaName || nodeUuid,
      // Screening nodes keep their prompt in `context`, not `instructions` — an
      // empty node_prompt left the hallucination judge grounding against nothing
      // and false-flagging the node's own scripted opener.
      node_prompt:
        typeof config?.instructions === "string" && config.instructions
          ? config.instructions
          : typeof config?.context === "string"
            ? config.context
            : "",
      available_intents:
        configIntents.length === 0 && screening ? screeningIntentsFromEdges(flowObj, nodeUuid) : configIntents,
      chosen_intent: chosen,
      required_variables: requiredVariables(config),
      // Screening workflow outputs (screening_disposition/status/…) are emitted
      // by the node itself, not extracted from the caller — grading them as
      // extractions produced phantom score-0 verdicts on every screening run.
      extracted_variables: screening
        ? Object.fromEntries(Object.entries(extracted).filter(([k]) => !k.startsWith("screening_")))
        : extracted,
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
