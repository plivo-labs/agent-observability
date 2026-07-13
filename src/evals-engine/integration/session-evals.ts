// AO Eval Engine — ingest adapter (background path).
//
// The eval sweeper judges sessions that were INGESTED (not handed over via a
// request). A client attaches, at call end, a generic "agent config" record
// describing what the agent was configured to do, and tags each transcript
// chat item with an opaque `node_ref`. This module turns the stored config +
// transcript into the engine's neutral `ConversationInput`, runs the same
// node/goal engine + conversation judges the rest of the product uses, and
// returns a verdict object keyed by those opaque refs.
//
// Nothing here knows about any specific agent platform: the config shape is the
// public ingest contract, and `ref` is echoed back untouched so the caller can
// map verdicts to whatever node identity it uses.

import type { LlmProvider } from "../../llm/index.js";
import { renderFullTranscript } from "../conversation-input.js";
import { evaluateSimulation } from "../evaluator.js";
import { evaluateConversationMetrics, zeroConversationMetrics } from "../judges/conversation-judges.js";
import { IDLE_TAG } from "../types.js";
import type {
  ConversationInput,
  EvalTurn,
  GoalInput,
  NodeEvalInput,
  NodeEvaluation,
  NodeGoalEvaluation,
  SimConversationMetrics,
} from "../types.js";

// ── the public ingest "agent config" shape (what a client sends) ─────────────
// Every field optional + read defensively — a client owns its own serialization
// and AO must never throw on a shape it doesn't recognise (a bad config yields
// an empty evaluation, not a crash).

export interface AgentConfigVariable {
  name?: string;
  /** Recording rule for the variable (how/when it should be captured). */
  rule?: string;
  /** Name of the tool/function the agent calls to record this variable
   *  (whatever the sender's platform convention is). When present, a
   *  function_call event with this name counts as that variable's extraction
   *  and its arguments supply the extracted value. */
  tool?: string;
}
export interface AgentConfigIntent {
  name?: string;
  description?: string;
  /** Name of the tool/function the agent calls when it selects this intent
   *  (whatever the sender's platform convention is — handoff/transfer/route
   *  tools). When present, a matching function_call or agent_handoff event on
   *  the node marks this intent as the node's chosen intent. */
  tool?: string;
}
export interface AgentConfigNode {
  /** Opaque per-node reference the caller correlates verdicts to (echoed back). */
  ref?: string;
  name?: string;
  instructions?: string;
  intents?: AgentConfigIntent[];
  variables?: AgentConfigVariable[];
}
export interface AgentConfigGoal {
  name?: string;
  instructions?: string;
}
export interface AgentConfig {
  flow_name?: string;
  global_prompt?: string;
  goals?: AgentConfigGoal[];
  nodes?: AgentConfigNode[];
  /** Runtime context the platform supplied to the agent — trigger inputs +
   *  mid-flow HTTP/tool outputs. Grounding evidence for the hallucination judge
   *  (see ConversationInput.global_variables). Accepted loosely; coerced to a
   *  flat string map. Absent when the sender didn't attach it. */
  global_variables?: Record<string, unknown>;
  /** TTS pronunciation map (word→guide) — see ConversationInput.pronunciation_guides. */
  pronunciation_guides?: Record<string, unknown>;
  /** Platform-spoken idle boilerplate (user-idle reminder / idle-hangup lines,
   *  verbatim as configured). An agent turn whose text matches one of these is
   *  tagged "[system idle prompt]" so the loop/adherence judges exempt it —
   *  the same tag the per-item `system_idle` flag produces, but derivable from
   *  config alone when the sender can't mark individual items. */
  idle_messages?: string[];
}

// ── ingested transcript shape (raw_report.events, as AO stores them) ─────────
export interface StoredEvent {
  type?: string;
  node_ref?: string;
  item?: {
    type?: string;
    role?: string;
    content?: unknown;
    name?: string; // function name (function_call / function_call_output)
    arguments?: unknown;
    output?: unknown;
    /** Turn the speaker was cut off mid-response. Rendered as a "[interrupted]"
     *  tag so the loop/adherence judges can exempt it (they only exempt what
     *  they can SEE). Absent until the uploader carries it. */
    interrupted?: boolean;
    /** Platform-spoken user-idle boilerplate (reminder/hangup), not agent
     *  speech. Rendered as "[system idle prompt]" so judges treat it as
     *  scaffolding. Absent until the uploader carries it. */
    system_idle?: boolean;
  };
}

const isTruthyFlag = (v: unknown): boolean => v === true || v === "true" || v === 1;

/** Normalize a spoken line for idle-message matching: case/whitespace-insensitive;
 *  ASR/TTS transcripts add/drop final periods and insert spaces before
 *  punctuation ("there ?"), so spaces preceding punctuation collapse and
 *  trailing space+punctuation strips entirely. */
function normalizeSpoken(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/ ([.,!?…;:])/g, "$1")
    .trim()
    .replace(/[\s.!?…]+$/, "");
}

/** Coerce config.idle_messages to a set of normalized strings. Entries that
 *  normalize to "" (pure punctuation) are dropped — an empty-string member
 *  would tag any punctuation-only agent turn. Never throws. */
function idleMessageSet(v: unknown): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(v)) {
    for (const m of v) {
      if (typeof m !== "string") continue;
      const n = normalizeSpoken(m);
      if (n) out.add(n);
    }
  }
  return out;
}

/** Whether a spoken line is explicitly marked idle: the sender's per-item
 *  `system_idle` flag, or a text match against the config's `idle_messages` —
 *  so a sender that can only attach config (not per-item flags) still gets the
 *  judges' exemptions. `norm` is the caller's precomputed normalizeSpoken(text). */
function isExplicitIdle(item: NonNullable<StoredEvent["item"]>, idleMessages: Set<string>, norm: string): boolean {
  return isTruthyFlag(item.system_idle) || (idleMessages.size > 0 && !!norm && idleMessages.has(norm));
}

/** Coerce a loosely-typed config map to a flat string→string map (values
 *  stringified, empties dropped). Returns undefined when there's nothing usable
 *  so callers can omit the field entirely. Never throws. */
function toStringMap(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!k || val == null) continue;
    const s = typeof val === "string" ? val : (() => { try { return JSON.stringify(val); } catch { return ""; } })();
    if (s) out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

const USER_ROLES = new Set(["user", "customer", "human", "caller", "callee", "contact"]);

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : textOf((c as { text?: unknown })?.text))).filter(Boolean).join(" ").trim();
  }
  return "";
}

/** Parse a function_call's arguments into an object when possible. Senders
 *  serialize arguments either as a JSON string or a raw object. */
function parseToolArguments(args: unknown): Record<string, unknown> | null {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(args) ? args : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Render a tool/function event as a labelled evidence line the judges read as
 *  supporting evidence (a grounded value from a tool must not read as fabricated). */
function toolEvidence(item: NonNullable<StoredEvent["item"]>): string {
  const name = typeof item.name === "string" ? item.name : "tool";
  if (item.type === "function_call") {
    // Prefer the parsed object so string-serialized arguments don't render
    // double-encoded (`"{\"value\": ...}"`) in the judge's transcript.
    const parsed = parseToolArguments(item.arguments);
    const args = parsed ? JSON.stringify(parsed) : item.arguments !== undefined ? JSON.stringify(item.arguments) : "";
    return `Tool_Call: ${name}(${args})`;
  }
  const out = item.output !== undefined ? (typeof item.output === "string" ? item.output : JSON.stringify(item.output)) : "";
  return `Tool_Result: ${name} -> ${out}`;
}

function nodeGoals(cfg: AgentConfig): GoalInput[] {
  const raw = Array.isArray(cfg.goals) ? cfg.goals : [];
  return raw
    .map((g): GoalInput | null => {
      const name = typeof g?.name === "string" ? g.name.trim() : "";
      if (!name) return null;
      return { goal_name: name, goal_instructions: typeof g.instructions === "string" ? g.instructions : "", flow_goal_id: 0 };
    })
    .filter((g): g is GoalInput => g !== null);
}

/** Parallel to the engine's `nodes`, in the same order: the opaque ref + name
 *  the caller needs to map each verdict back to its own node identity. */
export interface NodeRef {
  ref: string;
  name: string;
}

/**
 * Build the engine `ConversationInput` from a stored agent config + ingested
 * transcript events. Turns are grouped to config nodes by `node_ref` when the
 * transcript carries it; when it doesn't (e.g. a single-node agent), all turns
 * fall to the first configured node. Only nodes that actually saw a turn are
 * evaluated. Never throws.
 */
export function buildSessionEvalInput(
  config: AgentConfig,
  events: StoredEvent[],
): { input: ConversationInput; nodeRefs: NodeRef[] } {
  const cfgNodes = Array.isArray(config.nodes) ? config.nodes : [];
  const evs = Array.isArray(events) ? events : [];
  const idleMessages = idleMessageSet(config.idle_messages);

  // Index config nodes by ref; keep declaration order for the fallback bucket.
  // A node without a ref gets a synthetic internal grouping key (the sender
  // then can't correlate verdicts to node identity, but the node axis must
  // still be judged — with "" the fallback bucket would silently drop every
  // turn and the session would produce zero node evaluations). The prefix is
  // PRINTABLE on purpose: Postgres jsonb rejects the NUL escape, so a
  // NUL-based key would make storing the verdicts fail terminally. The echoed
  // NodeRef.ref is restored to the sender's original value below.
  const SYNTHETIC_REF = "__ao_unref_";
  const groupKeyFor = (n: AgentConfigNode | undefined, i: number): string =>
    (typeof n?.ref === "string" && n.ref) ? n.ref : `${SYNTHETIC_REF}${i}`;
  const byRef = new Map<string, AgentConfigNode>();
  cfgNodes.forEach((n, i) => { byRef.set(groupKeyFor(n, i), n); });
  // Ref-less turns fall to the first configured node ONLY when the whole
  // transcript is ref-less (single-node sender). In a mixed session a missing
  // ref means the sender failed to attribute that turn (e.g. a config capture
  // race) — bucketing it under node 0 would judge it against the wrong node,
  // so it goes to a synthetic unknown bucket (empty config -> neutral skips)
  // while still appearing in the full transcript.
  const anyEventHasRef = evs.some((e) => typeof e?.node_ref === "string" && e.node_ref);
  const fallbackRef = anyEventHasRef
    ? `${SYNTHETIC_REF}unattributed`
    : (cfgNodes.length > 0 ? groupKeyFor(cfgNodes[0], 0) : "");

  // Idle re-prompt auto-detection: a platform idle timer re-SPEAKS the same
  // configured line into user silence, so an agent message whose normalized
  // text equals the previous agent message with NO user speech between them
  // (same node) is idle scaffolding — tagged even when the sender attached no
  // idle_messages and no per-item flag. The FIRST occurrence is tagged
  // retroactively the moment a repeat proves the line is scripted (safe: the
  // turn objects are mutated before any transcript is rendered), so the whole
  // idle run carries the flag and the loop judge's deterministic filter drops
  // all of it. Repeat state resets on user speech (lastAgentSpokenNorm="").
  let lastAgentSpokenNorm = "";
  let lastAgentTurn: EvalTurn | null = null;
  // True while inside a detected idle run. The agent line that follows idle
  // re-prompts with STILL no user speech is the configured idle-hangup message
  // ("Since I'm not hearing a response…") — tag it too, but don't let it seed
  // further tagging (the chain ends there).
  let inIdleRun = false;
  // Platform idle retries are small (retries config, typically ≤3). A run of
  // identical lines LONGER than that is not idle scaffolding — it's an agent
  // genuinely stuck re-emitting the same line into dead air, which the loop
  // judge must still see. Repeats past the cap stay untagged.
  const MAX_IDLE_REPEATS = 3;
  let idleRepeatCount = 0;

  // Group each transcript turn under a node ref, preserving chronological order.
  const turnsByRef = new Map<string, EvalTurn[]>();
  const orderedRefs: string[] = [];
  // Whole-conversation timeline in true event order — per-ref buckets would
  // scramble the full transcript on node revisits (all A-turns then all
  // B-turns), misleading the conversation/goal judges.
  const allTurns: EvalTurn[] = [];
  const pushTurn = (ref: string, turn: EvalTurn) => {
    if (!turnsByRef.has(ref)) { turnsByRef.set(ref, []); orderedRefs.push(ref); }
    turnsByRef.get(ref)!.push(turn);
    allTurns.push(turn);
  };
  // Tool calls per node, for extracted_variables (config variables that
  // declare the tool that records them; see AgentConfigVariable.tool) and
  // chosen intents (config intents that declare their selection tool).
  const toolCallsByRef = new Map<string, Array<{ name: string; args: Record<string, unknown> | null }>>();
  // Session-wide tool-call list, in order — the cross-node fallback for
  // variable extraction on revisited nodes.
  const allToolCalls: Array<{ name: string; args: Record<string, unknown> | null }> = [];

  for (const ev of evs) {
    if (ev?.type !== "conversation_item_added" || !ev.item) continue;
    const ref = (typeof ev.node_ref === "string" && ev.node_ref) ? ev.node_ref : fallbackRef;
    if (!ref) continue;
    const item = ev.item;
    if (item.type === "function_call" || item.type === "function_call_output") {
      if (item.type === "function_call" && typeof item.name === "string" && item.name) {
        if (!toolCallsByRef.has(ref)) toolCallsByRef.set(ref, []);
        const call = { name: item.name, args: parseToolArguments(item.arguments) };
        toolCallsByRef.get(ref)!.push(call);
        allToolCalls.push(call);
      }
      pushTurn(ref, { node_uuid: ref, user: "", agent: toolEvidence(item), intent: "", evidence: true });
      continue;
    }
    if (item.type === "agent_handoff") {
      // Handoffs are the strongest chosen-intent evidence a sender can carry;
      // dropping them starves the intent judge. Render as a labelled evidence
      // line and count the handoff name as a tool signal for intent matching.
      const label = [item.name, (item as Record<string, unknown>).new_agent, (item as Record<string, unknown>).target]
        .find((v): v is string => typeof v === "string" && v.length > 0) ?? "";
      if (label) {
        if (!toolCallsByRef.has(ref)) toolCallsByRef.set(ref, []);
        const call = { name: label, args: null };
        toolCallsByRef.get(ref)!.push(call);
        allToolCalls.push(call);
      }
      pushTurn(ref, { node_uuid: ref, user: "", agent: label ? `Agent_Handoff: ${label}` : "Agent_Handoff", intent: "", evidence: true });
      continue;
    }
    const text = textOf(item.content);
    if (!text) continue;
    const role = (item.role ?? "").toLowerCase();
    const isUser = USER_ROLES.has(role);
    // System/developer messages are runtime-internal steering (prompts, hint
    // preprocessors, close instructions), not agent speech. Rendering them as
    // agent turns misleads judges (a buggy hint line reads as an agent claim;
    // the system prompt reads as something the agent "said"). Label them so
    // their evidence survives — the adversarial audit showed dropping them
    // loses intent context — and truncate so a full system prompt can't
    // dominate the judge's transcript (node instructions already arrive via
    // node_prompt).
    if (!isUser && (role === "system" || role === "developer")) {
      const note = text.length > 600 ? `${text.slice(0, 600)}…` : text;
      pushTurn(ref, { node_uuid: ref, user: "", agent: `System_Note: ${note}`, intent: "", evidence: true });
      continue;
    }
    if (isUser) {
      // User speech ends any idle run and resets repeat detection — a re-ask
      // after the user talks is a justified re-ask, never idle scaffolding.
      // (User lines are never text-matched against idle_messages either: the
      // reminder/hangup lines are platform-SPOKEN.)
      lastAgentSpokenNorm = "";
      lastAgentTurn = null;
      inIdleRun = false;
      idleRepeatCount = 0;
      const userText = isTruthyFlag(item.interrupted) ? `${text} [interrupted]` : text;
      pushTurn(ref, { node_uuid: ref, user: userText, agent: "", intent: "" });
      continue;
    }
    const norm = normalizeSpoken(text);
    // Idle by explicit signal (config match / per-item flag) vs by repeat detection.
    const explicitIdle = isExplicitIdle(item, idleMessages, norm);
    // An idle timer re-speaks within one node — an identical line across a node
    // boundary is that node's own opening, not a re-prompt, so ref must match.
    const sameAsPrev = !!norm && norm === lastAgentSpokenNorm && lastAgentTurn?.node_uuid === ref;
    const isIdleRepeat = sameAsPrev && idleRepeatCount < MAX_IDLE_REPEATS;
    let idle = explicitIdle;
    if (isIdleRepeat) {
      idle = true;
      idleRepeatCount++;
      // The repeat proves the previous identical line was the same scripted
      // re-prompt — tag it retroactively so the whole run is filterable.
      if (lastAgentTurn && !lastAgentTurn.idle) {
        lastAgentTurn.idle = true;
        lastAgentTurn.agent += ` ${IDLE_TAG}`;
      }
    } else if (inIdleRun && !explicitIdle && !sameAsPrev) {
      // Idle-hangup message: a DIFFERENT line directly following the exhausted
      // re-prompts, still with no user speech. Tagged, but it ends the run
      // (below) so it never seeds tagging of anything after it. A same-text
      // continuation past the cap is NOT a hangup — it stays visible.
      idle = true;
    }
    let tagged = idle ? `${text} ${IDLE_TAG}` : text;
    if (isTruthyFlag(item.interrupted)) tagged += " [interrupted]";
    // Only repeat-detected idle keeps the run alive: a sender that tags via
    // config/flags lists its hangup message explicitly, so inferring it there
    // would risk tagging a real line spoken after a single config-tagged prompt.
    inIdleRun = isIdleRepeat;
    // The counter tracks the CURRENT identical-line run; it resets when the
    // line changes (or on user speech), never mid-run — resetting mid-run
    // would re-arm tagging and hide an over-cap (genuinely stuck) run.
    if (!sameAsPrev) idleRepeatCount = 0;
    const turn: EvalTurn = { node_uuid: ref, user: "", agent: tagged, intent: "", ...(idle ? { idle: true } : {}) };
    lastAgentSpokenNorm = norm;
    lastAgentTurn = turn;
    pushTurn(ref, turn);
  }

  const nodes: NodeEvalInput[] = [];
  const nodeRefs: NodeRef[] = [];

  for (const ref of orderedRefs) {
    const turns = turnsByRef.get(ref) ?? [];
    if (turns.length === 0) continue;
    // A ref the config doesn't know (config snapshot gap, or a sender whose
    // transcript and config refs come from different id spaces) gets an EMPTY
    // def — the judges' neutral-skip paths then apply. Borrowing another
    // node's config here would produce confidently-wrong verdicts attributed
    // to a node that was never configured that way.
    const def: AgentConfigNode = byRef.get(ref) ?? {};
    const requiredVariables = (def.variables ?? [])
      .map((v) => v?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    const rules: Record<string, string> = {};
    for (const v of def.variables ?? []) {
      if (typeof v?.name === "string" && v.name && typeof v.rule === "string" && v.rule.trim()) rules[v.name] = v.rule.trim();
    }
    // Actual extractions: a config variable whose declared `tool` (or, absent
    // that, its own name) matches a function_call on this node was recorded by
    // the agent; the call's arguments carry the value. Without this, the
    // variable judge reads "(none) extracted" and fails runs whose transcript
    // plainly shows the recording calls.
    const nodeToolCalls = toolCallsByRef.get(ref) ?? [];
    const extractedVariables = deriveExtractedVariables(def, nodeToolCalls, allToolCalls);
    const chosenIntent = deriveChosenIntent(def, nodeToolCalls);
    nodes.push({
      node_uuid: ref,
      node_name: typeof def.name === "string" && def.name ? def.name : (ref.startsWith(SYNTHETIC_REF) ? "node" : ref),
      node_prompt: typeof def.instructions === "string" ? def.instructions : "",
      available_intents: Array.isArray(def.intents) ? def.intents.map((i) => ({ intent_name: i?.name, intent_instructions: i?.description })) : [],
      chosen_intent: chosenIntent,
      required_variables: requiredVariables,
      ...(Object.keys(rules).length ? { variable_rules: rules } : {}),
      extracted_variables: extractedVariables,
      turns,
      turn_count: turns.length,
    });
    // Synthetic grouping keys are internal — echo the sender's original
    // (empty) ref, never the NUL-prefixed key.
    const echoedRef = ref.startsWith(SYNTHETIC_REF) ? "" : ref;
    nodeRefs.push({ ref: echoedRef, name: typeof def.name === "string" ? def.name : echoedRef });
  }

  const globalVariables = toStringMap(config.global_variables);
  const pronunciationGuides = toStringMap(config.pronunciation_guides);

  return {
    input: {
      flow_name: typeof config.flow_name === "string" ? config.flow_name : "conversation",
      global_prompt: typeof config.global_prompt === "string" ? config.global_prompt : "",
      nodes,
      goals: nodeGoals(config),
      full_transcript: renderFullTranscript(allTurns),
      // Speech-only variant for the conversation-axis judges: drop the
      // synthetic evidence lines so config/tool text can't masquerade as
      // things said on the call.
      speech_transcript: renderFullTranscript(
        allTurns.filter(
          (t) => !t.evidence,
        ),
      ),
      // Grounding evidence for the hallucination judge (omitted when empty).
      ...(globalVariables ? { global_variables: globalVariables } : {}),
      ...(pronunciationGuides ? { pronunciation_guides: pronunciationGuides } : {}),
    },
    nodeRefs,
  };
}

/** The verdict object the sweeper stores. Node evaluations are keyed by the
 *  caller's opaque `ref`; conversation_metrics + goals are whole-transcript. */
export interface SessionEvalVerdicts {
  node_evaluations: Array<NodeEvaluation & { ref: string }>;
  conversation_metrics: SimConversationMetrics;
  goal_evaluation?: NodeGoalEvaluation["goal_evaluation"];
}

/**
 * Judge one ingested session. Runs the node/goal engine and the conversation
 * judges over the built input, and re-attaches each node's opaque `ref`.
 * Throws on a node-judge failure (the caller records that as a terminal eval
 * error); the conversation judges are internally fault-tolerant.
 */
export async function evaluateIngestedSession(
  config: AgentConfig,
  events: StoredEvent[],
  provider?: LlmProvider,
  /** Session transport/channel, from the session row. Gates the voice-only
   *  conversation detections so they don't fire on text (chat/SMS/WhatsApp). */
  transport?: string,
): Promise<SessionEvalVerdicts> {
  const { input, nodeRefs } = buildSessionEvalInput(config, events);
  if (transport) input.transport = transport;

  const [conversation_metrics, scored] = await Promise.all([
    input.full_transcript.trim()
      ? evaluateConversationMetrics(input, provider)
      : Promise.resolve(zeroConversationMetrics()),
    input.nodes.length
      ? evaluateSimulation(input, { provider })
      : Promise.resolve({ node_evaluations: [] } as NodeGoalEvaluation),
  ]);

  // evaluateSimulation preserves input.nodes order, so node_evaluations[i] ↔ nodeRefs[i].
  const node_evaluations = scored.node_evaluations.map((ne, i) => ({ ...ne, ref: nodeRefs[i]?.ref ?? "" }));

  return {
    node_evaluations,
    conversation_metrics,
    ...(scored.goal_evaluation ? { goal_evaluation: scored.goal_evaluation } : {}),
  };
}

type ToolCall = { name: string; args: Record<string, unknown> | null };

/** Variables the agent actually recorded on a node: a config variable whose
 *  declared `tool` (or its own name) matches a function_call. Prefers a call on
 *  this node, then any call in the session — a node revisit mints a fresh ref,
 *  but a variable recorded on an earlier visit must still count. */
function deriveExtractedVariables(
  def: AgentConfigNode,
  nodeToolCalls: ToolCall[],
  allToolCalls: ToolCall[],
): Record<string, unknown> {
  const extracted: Record<string, unknown> = {};
  for (const v of def.variables ?? []) {
    const varName = typeof v?.name === "string" ? v.name : "";
    if (!varName) continue;
    const toolName = typeof v?.tool === "string" && v.tool ? v.tool : varName;
    const call = nodeToolCalls.find((tc) => tc.name === toolName) ?? allToolCalls.find((tc) => tc.name === toolName);
    if (!call) continue;
    const args = call.args;
    if (args && Object.keys(args).length === 1) extracted[varName] = Object.values(args)[0];
    else if (args && Object.keys(args).length > 0) extracted[varName] = args;
    else extracted[varName] = "(recorded)";
  }
  return extracted;
}

/** The intent the agent selected on a node: a config intent whose declared
 *  `tool` (or its own name) matches a tool/handoff signal. Last match wins. */
function deriveChosenIntent(def: AgentConfigNode, nodeToolCalls: ToolCall[]): string {
  let chosen = "";
  for (const tc of nodeToolCalls) {
    for (const i of def.intents ?? []) {
      const intentName = typeof i?.name === "string" ? i.name : "";
      if (!intentName) continue;
      const toolName = typeof i?.tool === "string" && i.tool ? i.tool : intentName;
      if (tc.name === toolName) chosen = intentName;
    }
  }
  return chosen;
}
