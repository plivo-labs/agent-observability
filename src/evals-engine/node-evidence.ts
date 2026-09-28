import { renderFullTranscript } from "./conversation-input.js";
import type { ConversationInput, EvalTurn, NodeEvalInput } from "./types.js";

export const NODE_EVIDENCE_VERSION = "node-evidence-v3";
export const NODE_EVIDENCE_SCOPE =
  "Judge only actions owned by target_node_uuid, against its instructions. " +
  "node_transcript contains target events; conversation_history contains supporting events and references to target events, not repeated speech. " +
  "Event numbers identify one occurrence each. Other nodes are context, never accusation targets. " +
  "Evidence and extracted_variables stop at the target node's exit; later corrections belong to later nodes. " +
  "A node boundary is not proof that a particular intent tool executed.";

/** Ordered supporting speech/tools available by this node's exit. Legacy
 * callers have no timestamp ownership; retain their supplied history. */
export function transcriptThroughNodeExit(node: NodeEvalInput, ctx: ConversationInput): string {
  const exit = ctx.timeline?.findLastIndex(t => t.node_uuid === node.node_uuid) ?? -1;
  return ctx.timeline && exit >= 0 ? renderFullTranscript(ctx.timeline.slice(0, exit + 1)) : ctx.full_transcript;
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
    // Legacy callers do not supply inter-node order. Do not invent one, or
    // repeat unowned full_transcript alongside node turns. Real adapters carry
    // timeline; retain explicitly labelled context for older callers.
    target.push(...node.turns.filter(visible).map(render));
    for (const other of ctx.nodes) {
      if (other.node_uuid === node.node_uuid) continue;
      context.push(`[node ${other.node_uuid}; context only; chronology unavailable]\n${other.turns.filter(visible).map(render).join("\n")}`);
    }
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
