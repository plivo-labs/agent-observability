import type { ConversationInput, NodeEvalInput } from "../types.js";
import { isVoiceChannel } from "../judges/conversation-judges.js";
import { renderFullTranscript } from "../conversation-input.js";
import { contextThroughNodeExit } from "../node-evidence.js";
import { clipToolResults } from "../../jev/tokens.js";
import { configExcerpts } from "../../jev/hallucination-grounding.js";
import {
  ADHERENCE_QUESTIONS,
  CONVERSATION_QUESTIONS,
  HALLUCINATION_QUESTIONS,
  JEV_FENCE,
  MAX_VARIABLE_QUESTIONS,
  NODE_LOOP_QUESTION,
  customMetricQuestions,
  intentQuestions,
  variableQuestions,
} from "../../jev/questions.js";
import type { JevNoul, JevRequest } from "../../jev/types.js";
import {
  CONVERSATION_JUDGES,
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_JEV_JUDGES,
  VOICE_ONLY,
  buildJevPlan,
  type BuildJevPlanOptions,
  type JevAxis,
  type JevPlan,
} from "./plan.js";

// Every node judge over ONE shared state; conversation judges keep their own
// speech-only request. Data only one judge may read rides inside its question.
// An oversized session packs by node into two requests, never more.

export const SHARED_LAYOUT_VERSION = "shared-state-v1";

const SPEECH_KEYS = new Set(["conversation", "events", "agent_said"]);
const TOTAL_BUDGET_MULTIPLE = 2;
const NOTE_CHARS = 240;
const MAX_REASON_LINES = 6;
const LINE_CHARS = 400;

/** tokens.ts rates (speech 0.35 tok/char, config 0.25) keyed by this layout's field names. */
function estimateState(v: unknown, key = ""): number {
  if (typeof v === "string") return Math.ceil((v.length + key.length + 4) * (SPEECH_KEYS.has(key) ? 0.35 : 0.25));
  if (Array.isArray(v)) return v.reduce((sum: number, x) => sum + estimateState(x, key), 0);
  if (v && typeof v === "object") return Object.entries(v).reduce((sum, [k, x]) => sum + estimateState(x, k), 0);
  return Math.ceil((JSON.stringify(v ?? "").length + key.length) * 0.25);
}
const estimateQuestion = (q: JevNoul): number => {
  const speech = typeof q.instructions === "object" && typeof q.instructions.call_speech === "string" ? q.instructions.call_speech.length : 0;
  return Math.ceil(JSON.stringify(q).length * 0.25 + speech * 0.1) + 10;
};

const LINE_LABELS = ["User:", "Agent:", "Tool_Call:", "Tool_Result:", "System_Note:", "Agent_Handoff:"];
/** A runtime System_Note re-sends the whole rendered prompt (~12k chars) that
 *  the node's instructions already carry; keep only its head. */
export function clipSystemNotes(text: string, max: number = NOTE_CHARS): string {
  const out: string[] = [];
  let inNote = false;
  let used = 0;
  let marked = false;
  for (const line of text.split("\n")) {
    if (LINE_LABELS.some((l) => line.startsWith(l))) { inNote = line.startsWith("System_Note:"); used = 0; marked = false; }
    if (!inNote) { out.push(line); continue; }
    if (used >= max) { if (!marked) { out.push("…[runtime note clipped]"); marked = true; } continue; }
    const room = max - used;
    used += line.length + 1;
    out.push(line.length > room ? line.slice(0, room) : line);
  }
  return out.join("\n");
}

function nodeEvents(ctx: ConversationInput, node: NodeEvalInput): { text: string; last: number } {
  const lines: string[] = [];
  let last = -1;
  (ctx.timeline ?? []).forEach((turn, i) => {
    if (turn.node_uuid !== node.node_uuid) return;
    last = i;
    lines.push(`[e${i}] ${clipSystemNotes(clipToolResults(renderFullTranscript([turn])))}`);
  });
  return { text: lines.length ? lines.join("\n") : clipToolResults(renderFullTranscript(node.turns ?? [])), last };
}

function intentsOf(node: NodeEvalInput): Array<{ name: string; tool: string | null; condition: unknown }> {
  return (node.available_intents ?? []).map((raw) => {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const name = String(o.intent_name ?? o.name ?? "");
    return { name, tool: node.intent_tools?.[name] ?? null, condition: o.intent_instructions ?? o.description ?? null };
  });
}

/** Paragraphs 2+ nodes carry verbatim are sent once; format-agnostic. */
function shareInstructions(nodes: readonly NodeEvalInput[]): { shared: string; own: string[] } | null {
  const paras = nodes.map((n) => (n.node_prompt ?? "").split(/\n\s*\n/).filter((x) => x.trim()));
  const count = new Map<string, number>();
  for (const list of paras) for (const x of new Set(list)) count.set(x, (count.get(x) ?? 0) + 1);
  const shared: string[] = [];
  const seen = new Set<string>();
  for (const list of paras) for (const x of list) if ((count.get(x) ?? 0) > 1 && !seen.has(x)) { seen.add(x); shared.push(x); }
  if (!shared.length) return null;
  return { shared: shared.join("\n\n"), own: paras.map((list) => list.filter((x) => (count.get(x) ?? 0) < 2).join("\n\n")) };
}

const REASON_WORDS = /\b(because|so that|so we|to make sure|in order to|we only|required|requires|need (your|to|a)|have to|must|helps? (us|the|you)|policy|so I can|to ensure)\b/i;

interface NodePart { index: number; state: Record<string, unknown>; questions: Record<string, JevNoul>; axes: JevAxis[] }

export function buildSharedJevPlan(ctx: ConversationInput, opts: BuildJevPlanOptions = {}): JevPlan {
  const judges = opts.judges ?? DEFAULT_JEV_JUDGES;
  const allowed = (judge: string) => judges.includes(judge);
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const hasTranscript = !!ctx.full_transcript?.trim();
  const voice = isVoiceChannel(ctx.transport);
  const nodes = ctx.nodes ?? [];
  const share = shareInstructions(nodes);
  const keyOfNode = new Map(nodes.map((n, i) => [n.node_uuid, `nodes.n${i}`]));

  const paths = (i: number) => {
    const n = `nodes.n${i}`;
    return {
      node: `\`${n}\``,
      ins: share ? `\`${n}.instructions\` (together with the shared \`agent.shared_instructions\`)` : `\`${n}.instructions\``,
      ev: `\`${n}.events\``,
      sources: `\`${n}.result.variable_sources\``,
      excerpts: `\`${n}.runtime_excerpts\``,
    };
  };
  const scope = (i: number, name: string) =>
    `This question is about node ${paths(i).node} ("${name}") only. Its own events are ${paths(i).ev}; events of other nodes are context and never the subject of this question. `;
  const bare = (q: JevNoul) => (q.instructions as string).replace(JEV_FENCE, "");

  const parts: NodePart[] = nodes.map((node, i): NodePart => {
    const p = paths(i);
    const name = node.node_name ?? `node ${i}`;
    const { text: events, last } = nodeEvents(ctx, node);
    const exit = !ctx.timeline || last < 0 ? "unknown" : last < ctx.timeline.length - 1 ? "another node follows" : "end of call";
    const intents = intentsOf(node);
    const grounding = contextThroughNodeExit(node, ctx);
    const agentLines = events.split("\n").filter((l) => /^(\[e\d+\] )?Agent:/.test(l)).map((l) => l.replace(/^\[e\d+\] /, ""));
    // Name writers by state key: the node uuid appears nowhere else in this
    // state, so a write in THIS node would read as one made elsewhere.
    const sources = Object.fromEntries(Object.entries(node.variable_sources ?? {}).map(([v, w]) => [v, {
      node: w.node_uuid === node.node_uuid ? `this node (nodes.n${i})` : keyOfNode.get(w.node_uuid) ?? "another node",
      event: w.event_index != null ? `e${w.event_index}` : "unknown",
      status: w.status,
    }]));
    const state: Record<string, unknown> = {
      name,
      instructions: share ? share.own[i] ?? "" : node.node_prompt ?? "",
      variables: (node.required_variables ?? []).map((v) => ({ name: v, rule: node.variable_rules?.[v] ?? null })),
      result: { recorded: node.extracted_variables ?? {}, ...(Object.keys(sources).length ? { variable_sources: sources } : {}) },
      exit,
      events,
    };
    const excerpts = configExcerpts({ ...grounding, nodes: [], global_prompt: "", global_variables: {} }, agentLines);
    if (excerpts.length) state.runtime_excerpts = excerpts;

    const questions: Record<string, JevNoul> = {};
    const axes: JevAxis[] = [];

    if (allowed("node_loop")) {
      const key = `n${i}.node_loop`;
      questions[key] = { ...NODE_LOOP_QUESTION, instructions: scope(i, name) + bare(NODE_LOOP_QUESTION) +
        " Lines tagged [system idle prompt] are platform reminders, not the agent repeating itself." + JEV_FENCE };
      axes.push({ kind: "node", id: `n${i}:node_loop`, judge: "node_loop", nodeIndex: i, requestKey: "", questionKeys: [key] });
    }
    if (allowed("instructions_adherence") && (node.node_prompt ?? "").trim()) {
      const keys: string[] = [];
      for (const [nm, base] of Object.entries(ADHERENCE_QUESTIONS)) {
        const key = `a${i}.${nm}`;
        questions[key] = { ...base, instructions: scope(i, name) + (base.instructions as string).replace(/node_prompt/g, p.ins).replace(/node_transcript/g, p.ev) };
        keys.push(key);
      }
      axes.push({ kind: "node", id: `n${i}:instructions_adherence`, judge: "instructions_adherence", nodeIndex: i, requestKey: "", questionKeys: keys });
    }
    if (allowed("intent_identification") && intents.length) {
      const keys: string[] = [];
      const refs = [];
      for (const { key: k, question } of intentQuestions(node)) {
        const key = `i${i}.${k}`;
        questions[key] = { ...question, instructions: {
          node: name, available_intents: intents, chosen_intent: node.chosen_intent || "(none recorded)",
          question: scope(i, name) + bare(question).replace(/available_intents( list)?/g, "`available_intents`").replace(/node_transcript/g, p.ev).replace(/chosen_intent/g, "`chosen_intent`") +
            ` Judge each intent against its own condition in \`available_intents\`; ${p.ins} describe the agent's job, not when an intent may fire.` + JEV_FENCE,
        } };
        keys.push(key);
        refs.push({ key, intent: "" });
      }
      const firedTools = Object.values(node.intent_tools ?? {}).filter((t) => events.includes(`Tool_Call: ${t}(`));
      const fired = !!node.chosen_intent || firedTools.length > 0;
      const firedKeys: string[] = [];
      const checked = new Set<string>();
      intents.forEach((it, k) => {
        const m = it.tool ? events.match(new RegExp(`\\[e(\\d+)\\] Tool_Call: ${it.tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\(`)) : null;
        if (!m) return;
        const key = `i${i}.fired.${k}`;
        checked.add(it.tool!);
        checked.add(it.name);
        questions[key] = { type: "noul", instructions: {
          fired_intent: { name: it.name, condition: it.condition }, fired_at: `event e${m[1]} of ${p.ev}`,
          question: scope(i, name) + "The agent fired `fired_intent` at `fired_at`. Before that event, had the caller actually met EVERY requirement in " +
            "`fired_intent.condition`? Check each requirement separately against the caller's own words. When a requirement is that the caller confirms a value, " +
            "a value the agent only stated back without the caller saying yes to it is NOT confirmed. Answer TRUE if any requirement was not met when it fired." + JEV_FENCE },
          criteria: { true: "at least one requirement of the condition was not met when the intent fired", false: "every requirement was met before it fired" } };
        firedKeys.push(key);
      });
      // Jev may decide a fired intent only when EVERY firing was asked about —
      // an intent with no tool fires by name and gets no question.
      const allChecked = firedTools.every((t) => checked.has(t)) && (!node.chosen_intent || checked.has(node.chosen_intent));
      axes.push({ kind: "node", id: `n${i}:intent_identification`, judge: "intent_identification", nodeIndex: i, requestKey: "",
        questionKeys: [...keys, ...firedKeys], intents: refs, ...(fired ? { intentFired: true } : {}), ...(firedKeys.length && allChecked ? { firedChecked: true } : {}) });
    }
    if (allowed("variable_extraction")) {
      const vars = variableQuestions(node);
      if (vars.length) {
        const refs = vars.map(({ key: k, question, variable, recorded }) => {
          const key = `v${i}.${k}`;
          questions[key] = { ...question, instructions: scope(i, name) + bare(question).replace(/node_transcript/g, p.ev).replace(/variable_sources/g, p.sources) + JEV_FENCE };
          return { key, variable, recorded };
        });
        axes.push({ kind: "node", id: `n${i}:variable_extraction`, judge: "variable_extraction", nodeIndex: i, requestKey: "",
          questionKeys: refs.map((r) => r.key), variables: refs,
          ...((node.required_variables?.length ?? 0) > MAX_VARIABLE_QUESTIONS ? { truncated: true } : {}) });
      }
    }
    if (allowed("hallucination") && agentLines.length && hasTranscript) {
      const keys: string[] = [];
      const spoken = `the Agent: lines of ${p.ev}`;
      for (const [nm, base] of Object.entries(HALLUCINATION_QUESTIONS)) {
        const key = `h${i}.${nm}`;
        questions[key] = { ...base, instructions: scope(i, name) + (base.instructions as string)
          .replace(/\(agent_spoken\)/g, `(${spoken})`).replace(/agent_spoken/g, spoken)
          .replace(/node_instructions_full/g, p.ins).replace(/global_prompt/g, "`agent.global_prompt`")
          .replace(/the config excerpts/g, p.excerpts)
          .replace(/any tool_results/g, "any Tool_Result line of the call so far") };
        keys.push(key);
      }
      // One question per reason/requirement line: a single broad policy question
      // goes soft over a whole-session state.
      const reasonLines = agentLines.map((l) => l.replace(/^Agent:\s*/, "").slice(0, LINE_CHARS)).filter((l) => REASON_WORDS.test(l));
      reasonLines.slice(0, MAX_REASON_LINES).forEach((line, k) => {
        const key = `h${i}.why.${k}`;
        questions[key] = { type: "noul", instructions: { agent_line: line,
          question: scope(i, name) + "The agent said `agent_line`. Does it state a reason, purpose, benefit, requirement or policy — 'we ask because…', " +
            "'to make sure we connect you with…', 'X is required' — that is NOT stated in " + p.ins + ", `agent.global_prompt` or a Tool_Result of the call? " +
            "Restating what the caller said, or a line the instructions script, is not this." + JEV_FENCE },
          criteria: { true: "the line states a reason, requirement or policy the instructions do not give", false: "it is backed by the instructions or tools, or states none" } };
        keys.push(key);
      });
      // No per-token claim questions: this layout was measured without them.
      // Lines past the cap were never asked, so a pass needs the LLM.
      const truncated = reasonLines.length > MAX_REASON_LINES;
      axes.push({ kind: "node", id: `n${i}:hallucination`, judge: "hallucination", nodeIndex: i, requestKey: "", questionKeys: keys, ...(truncated ? { truncated: true } : {}) });
    }
    return { index: i, state, questions, axes };
  });

  // Custom metrics are candidates only, never published by Jev.
  if (opts.customEnabled && hasTranscript && parts.length) {
    for (const spec of opts.customSpecs ?? []) {
      const { applicable, fail } = customMetricQuestions(spec);
      const targets = spec.scope === "conversation" ? [{ part: parts[0]!, prefix: `m.${spec.name}`, lead: "Read the events of every node in `nodes`, the whole call in event order. " }]
        : parts.map((part) => ({ part, prefix: `m${part.index}.${spec.name}`, lead: scope(part.index, nodes[part.index]!.node_name ?? `node ${part.index}`) }));
      for (const { part, prefix, lead } of targets) {
        const applicableKey = `${prefix}.applicable`;
        const failKey = `${prefix}.fail`;
        part.questions[applicableKey] = { ...applicable, instructions: lead + (applicable.instructions as string) };
        part.questions[failKey] = { ...fail, instructions: lead + (fail.instructions as string) };
        part.axes.push({ kind: "custom", id: prefix, judge: spec.name, scope: spec.scope, requestKey: "", questionKeys: [applicableKey, failKey], applicableKey, failKey,
          ...(spec.scope === "node" ? { nodeIndex: part.index } : {}) });
      }
    }
  }

  const agent: Record<string, unknown> = { global_prompt: ctx.global_prompt ?? "", global_variables: ctx.global_variables ?? {} };
  if (share) agent.shared_instructions = share.shared;
  const stateOf = (ps: NodePart[]) => ({ agent, nodes: Object.fromEntries(ps.map((x) => [`n${x.index}`, x.state])) });
  const measure = (state: unknown, questions: Record<string, JevNoul>) => {
    const s = estimateState(state);
    const q = Object.values(questions).map(estimateQuestion);
    const longest = s + Math.max(0, ...q);
    const total = s + q.reduce((a, b) => a + b, 0);
    return { longest, total, fits: longest <= budget && total <= budget * TOTAL_BUDGET_MULTIPLE };
  };
  const requests: JevRequest[] = [];
  const axes: JevAxis[] = [];
  const dropped: JevPlan["dropped"] = [];
  const emit = (key: string, state: unknown, questions: Record<string, JevNoul>, pending: JevAxis[]) => {
    if (!Object.keys(questions).length) return;
    const m = measure(state, questions);
    for (const axis of pending) axes.push({ ...axis, requestKey: key });
    if (!m.fits) { dropped.push({ requestKey: key, estTokens: m.longest }); return; }
    requests.push({ key, state, questions, estTokens: m.longest, estTotalTokens: m.total });
  };
  const gather = (ps: NodePart[]) => {
    const questions: Record<string, JevNoul> = {};
    const pending: JevAxis[] = [];
    for (const x of ps) { Object.assign(questions, x.questions); pending.push(...x.axes); }
    return { questions, pending };
  };

  const conversationJudges = CONVERSATION_JUDGES.filter((j) => allowed(j));
  // Byte-identical to the views layout's conversation request, so its gates hold.
  const conversationRequest = () => {
    const plan = buildJevPlan({ ...ctx, nodes: [] }, { judges: conversationJudges, customEnabled: false, budgetTokens: budget });
    requests.push(...plan.requests);
    axes.push(...plan.axes);
    dropped.push(...plan.dropped);
  };
  const all = gather(parts);
  if (parts.length < 2 || !Object.keys(all.questions).length || measure(stateOf(parts), all.questions).fits) {
    conversationRequest();
    emit("s0", stateOf(parts), all.questions, all.pending);
    return { requests, axes, dropped, layout: SHARED_LAYOUT_VERSION };
  }

  const speech = clipToolResults(ctx.speech_transcript || ctx.full_transcript);
  const convQuestions: Record<string, JevNoul> = {};
  const convAxes: JevAxis[] = [];
  if (hasTranscript) {
    for (const judge of conversationJudges) {
      if (!voice && VOICE_ONLY.has(judge)) continue;
      const base = CONVERSATION_QUESTIONS[judge]!;
      const key = `c.${judge}`;
      convQuestions[key] = { ...base, instructions: { call_speech: speech,
        question: "Judge only `call_speech`, the spoken words of this call given in this question; ignore every other part of the input. " + (base.instructions as string) } };
      convAxes.push({ kind: "conversation", id: key, judge, requestKey: "", questionKeys: [key] });
    }
  }
  const size = (x: NodePart) => estimateState(x.state) + Object.values(x.questions).reduce((s, q) => s + estimateQuestion(q), 0);
  const bins: NodePart[][] = [[], []];
  const load = [Object.values(convQuestions).reduce((s, q) => s + estimateQuestion(q), 0), 0];
  for (const x of [...parts].sort((a, b) => size(b) - size(a))) {
    const b = load[0]! <= load[1]! ? 0 : 1;
    bins[b]!.push(x);
    load[b]! += size(x);
  }
  for (const b of bins) b.sort((x, y) => x.index - y.index);
  const first = gather(bins[0]!);
  const second = gather(bins[1]!);
  const firstQuestions = { ...convQuestions, ...first.questions };
  if (bins[0]!.length && measure(stateOf(bins[0]!), firstQuestions).fits && measure(stateOf(bins[1]!), second.questions).fits) {
    emit("s0", stateOf(bins[0]!), firstQuestions, [...convAxes, ...first.pending]);
    emit("s1", stateOf(bins[1]!), second.questions, second.pending);
    return { requests, axes, dropped, layout: `${SHARED_LAYOUT_VERSION}/packed` };
  }

  // Speech too long to share a node request: the standalone conversation
  // request plus the nodes that fit one more; the rest go to the LLM.
  conversationRequest();
  const kept: NodePart[] = [];
  const rest: NodePart[] = [];
  for (const x of parts) (measure(stateOf([...kept, x]), gather([...kept, x]).questions).fits ? kept : rest).push(x);
  const fit = gather(kept);
  emit("s0", stateOf(kept), fit.questions, fit.pending);
  const over = gather(rest);
  if (over.pending.length) {
    for (const axis of over.pending) axes.push({ ...axis, requestKey: "s1" });
    dropped.push({ requestKey: "s1", estTokens: measure(stateOf(rest), over.questions).longest });
  }
  return { requests, axes, dropped, layout: `${SHARED_LAYOUT_VERSION}/packed` };
}
