import type { ConversationInput, NodeEvalInput } from "../types.js";
import { renderFullTranscript } from "../conversation-input.js";
import { idleFreeTranscript, withoutIdleTurns } from "../judges/node-judges.js";
import { clipToolResults } from "../../jev/tokens.js";
import { NODE_EVIDENCE_VERSION, scopedNodeEvidence } from "../node-evidence.js";

export const EVIDENCE_VERSION = NODE_EVIDENCE_VERSION;

/** Prepare shared call views once; never reconstruct chronology by grouping nodes. */
export function prepareEvidence(ctx: ConversationInput) {
  const history = (loop: boolean) => ctx.timeline
    ? ctx.timeline.map((turn, i) => ({ turn, i })).filter(({ turn }) => !loop || !turn.idle).map(({ turn, i }) =>
      `[event ${i}; node ${turn.node_uuid}]\n${clipToolResults(renderFullTranscript([turn]))}`).join("\n")
    : clipToolResults(loop ? idleFreeTranscript(ctx) : ctx.full_transcript);
  const conversation = history(false);
  const loopConversation = history(true);
  return {
    ctx,
    version: EVIDENCE_VERSION,
    fullTranscript: clipToolResults(ctx.full_transcript),
    conversation,
    loopConversation,
    chronologyAvailable: !!ctx.timeline,
    nodes: new Map(ctx.nodes.map(node => [node, {
      transcript: clipToolResults(renderFullTranscript(node.turns)),
      loopTranscript: clipToolResults(renderFullTranscript(withoutIdleTurns(node).turns)),
    }])),
  };
}
export type PreparedEvidence = ReturnType<typeof prepareEvidence>;

export function nodeEvidence(node: NodeEvalInput, evidence: PreparedEvidence, loop = false) {
  return scopedNodeEvidence(node, evidence.ctx, { loop, render: clipToolResults });
}
