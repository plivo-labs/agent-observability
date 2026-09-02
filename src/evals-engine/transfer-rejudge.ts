import type { ConversationInput, SimConversationMetrics } from "./types.js";
import type { SessionEvalVerdicts } from "./integration/session-evals.js";
import { evaluateTransferAxis } from "./judges/conversation-judges.js";

// AO Eval Engine — re-derive ONLY the transfer axis on an already-judged session.
//
// The backfill case: a session was judged before the axis existed (or before
// its platform emitted the `transfer:human` tag), and the tag is imported
// afterwards. Re-running the whole session would re-spend every judge and let
// every other verdict drift with the current model; this touches exactly one
// field and leaves the rest byte-identical. The axis is decided in code from
// the tag, so the re-judge costs nothing and makes the same decision the live
// path would have.

/** Pure with respect to `stored`: returns a new verdicts object whose
 *  conversation_metrics carry a fresh human_transfer; every other field
 *  (node_evaluations, goals, the other detections) is the same value —
 *  node_evaluations by reference. */
export function rejudgeTransferAxis(
  input: ConversationInput,
  stored: SessionEvalVerdicts,
): SessionEvalVerdicts {
  const cm = stored.conversation_metrics ?? ({} as SimConversationMetrics);
  return { ...stored, conversation_metrics: { ...cm, ...evaluateTransferAxis(input) } };
}
