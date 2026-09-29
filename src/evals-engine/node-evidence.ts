import { renderFullTranscript } from "./conversation-input.js";
import type { ConversationInput, EvalTurn, NodeEvalInput } from "./types.js";
import { IDLE_TAG } from "./types.js";

export const NODE_EVIDENCE_VERSION = "node-evidence-v3";
export const NODE_EVIDENCE_SCOPE =
  "Judge only actions owned by target_node_uuid, against its instructions. " +
  "node_transcript contains target events; conversation_history contains supporting events and references to target events, not repeated speech. " +
  "Event numbers identify one occurrence each. Other nodes are context, never accusation targets. " +
  "When chronology_available=true, evidence and extracted_variables stop at the target node's exit; later corrections belong to later nodes. " +
  "LEGACY INPUT (chronology_available=false): views may overlap. Never count a line copied between views as another occurrence; " +
  "only node_transcript is an accusation target. Unowned history is grounding context, with no reliable timing or attribution. " +
  "A node boundary is not proof that a particular intent tool executed.";

/** Ordered supporting speech/tools available by this node's exit. Legacy
 * callers have no timestamp ownership; retain their supplied history. */
export function transcriptThroughNodeExit(node: NodeEvalInput, ctx: ConversationInput): string {
  const exit = ctx.timeline?.findLastIndex(t => t.node_uuid === node.node_uuid) ?? -1;
  return ctx.timeline && exit >= 0 ? renderFullTranscript(ctx.timeline.slice(0, exit + 1)) : ctx.full_transcript;
}

/** Grounding also consumes full runtime notes, beyond the shortened transcript
 * notes. Bound those by the same event cutoff; retain legacy unindexed inputs. */
export function contextThroughNodeExit(node: NodeEvalInput, ctx: ConversationInput): ConversationInput {
  const exit = ctx.timeline?.findLastIndex(t => t.node_uuid === node.node_uuid) ?? -1;
  if (!ctx.timeline || exit < 0) return ctx;
  return {
    ...ctx,
    full_transcript: transcriptThroughNodeExit(node, ctx),
    ...(ctx.system_message_events ? {
      system_messages: ctx.system_message_events.filter(message => message.event_index <= exit).map(message => message.text),
    } : {}),
  };
}

/** Disjoint views of the same timeline: no duplicated speech, no future leakage.
 * Transform per event (e.g. Jev tool clipping) so event ownership survives. */
export function scopedNodeEvidence(
  node: NodeEvalInput,
  ctx: ConversationInput,
  options: { loop?: boolean; render?: (text: string) => string } = {},
) {
  const render = (turn: EvalTurn) => (options.render ?? ((text: string) => text))(renderFullTranscript([turn]));
  const visible = (turn: EvalTurn) => !options.loop || !turn.idle;
  const timeline = ctx.timeline;
  const exit = timeline?.findLastIndex(t => t.node_uuid === node.node_uuid) ?? -1;
  const target: string[] = [];
  const context: string[] = [];
  if (timeline && exit >= 0) {
    timeline.slice(0, exit + 1).forEach((turn, i) => {
      if (!visible(turn)) return;
      const label = `[event ${i}; node ${turn.node_uuid}]`;
      if (turn.node_uuid === node.node_uuid) {
        target.push(`${label}\n${render(turn)}`);
        context.push(`${label} see node_transcript`);
      } else {
        context.push(`${label} context only\n${render(turn)}`);
      }
    });
  } else {
    // Legacy callers can have grounding evidence ONLY in full_transcript.
    // Preserve it rather than fabricating ownership by matching speech text.
    // The scope contract marks this view as possibly overlapping/unordered.
    target.push(...node.turns.filter(visible).map(render));
    const history = options.loop ? ctx.full_transcript.split("\n").filter(line => !line.includes(IDLE_TAG)).join("\n") : ctx.full_transcript;
    context.push((options.render ?? ((text: string) => text))(history));
  }
  return {
    evidence_version: NODE_EVIDENCE_VERSION,
    target_node_uuid: node.node_uuid,
    scope: NODE_EVIDENCE_SCOPE,
    chronology_available: !!timeline && exit >= 0,
    node_boundary: !timeline || exit < 0 ? "unknown" : exit < timeline.length - 1 ? "another_node_follows" : "end_of_transcript",
    node_transcript: target.join("\n"),
    conversation_history: context.join("\n"),
  };
}
