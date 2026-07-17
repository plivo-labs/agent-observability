import { renderFullTranscript } from "../conversation-input.js";
import type { ConversationInput, NodeEvalInput } from "../types.js";

/** Render a node's turns with the shared speech/evidence labelling rules. */
export function renderNodeTranscript(node: NodeEvalInput): string {
  return renderFullTranscript(node.turns);
}

/** Shared user payload for node judges. */
export function nodePayload(node: NodeEvalInput, ctx: ConversationInput): Record<string, unknown> {
  const hasEntries = (values: Record<string, unknown> | undefined): values is Record<string, unknown> =>
    !!values && Object.keys(values).length > 0;

  return {
    global_prompt: ctx.global_prompt,
    node_name: node.node_name,
    node_prompt: node.node_prompt,
    available_intents: node.available_intents,
    chosen_intent: node.chosen_intent,
    node_transcript: renderNodeTranscript(node),
    conversation_history: ctx.full_transcript,
    ...(hasEntries(node.extracted_variables) ? { extracted_variables: node.extracted_variables } : {}),
    ...(hasEntries(ctx.global_variables) ? { global_variables: ctx.global_variables } : {}),
    ...(hasEntries(ctx.pronunciation_guides) ? { pronunciation_guides: ctx.pronunciation_guides } : {}),
  };
}
