import type { ConversationInput, NodeEvalInput } from "../types.js";
import { renderFullTranscript } from "../conversation-input.js";
import { idleFreeTranscript, withoutIdleTurns } from "../judges/node-judges.js";
import { clipToolResults } from "../../jev/tokens.js";

export const EVIDENCE_VERSION = "node-evidence-v2";

/** Prepare shared call views once; never reconstruct chronology by grouping nodes. */
export function prepareEvidence(ctx: ConversationInput) {
  const history = (loop: boolean) => ctx.timeline
    ? ctx.timeline.map((turn, i) => ({ turn, i })).filter(({ turn }) => !loop || !turn.idle).map(({ turn, i }) =>
      `[event ${i}; node ${turn.node_uuid}]\n${renderFullTranscript([turn])}`).join("\n")
    : loop ? idleFreeTranscript(ctx) : ctx.full_transcript;
  const conversation = clipToolResults(history(false));
  const loopConversation = clipToolResults(history(true));
  return {
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
  const view = evidence.nodes.get(node) ?? {
    transcript: clipToolResults(renderFullTranscript(node.turns)),
    loopTranscript: clipToolResults(renderFullTranscript(withoutIdleTurns(node).turns)),
  };
  return {
    evidence_version: evidence.version,
    target_node_uuid: node.node_uuid,
    scope: "Judge only target node actions. Other nodes are context, not actions by this node.",
    chronology_available: evidence.chronologyAvailable,
    node_transcript: loop ? view.loopTranscript : view.transcript,
    conversation_history: loop ? evidence.loopConversation : evidence.conversation,
  };
}
