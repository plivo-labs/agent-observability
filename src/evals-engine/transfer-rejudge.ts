import type { LlmProvider } from "../llm/index.js";
import type { ConversationInput, SimConversationMetrics } from "./types.js";
import type { SessionEvalVerdicts } from "./integration/session-evals.js";
import { evaluateTransferAxis, type DetectionResult } from "./judges/conversation-judges.js";

// AO Eval Engine — re-judge ONLY the transfer axis on an already-judged session.
//
// The backfill case: a session was judged before the transfer axis existed (or
// before its platform emitted the `transfer:human` tag), and the tag is imported
// afterwards. Re-running the whole session would re-spend every judge and let
// every other verdict drift with the current model; this touches exactly two
// fields and leaves the rest byte-identical. The stored `user_never_spoke`
// verdict feeds the consent judge's no_caller short-circuit, so the re-judge
// makes the same decision the live path would have.

/** A stored CmDetection back into the raw shape the judges consume. Verdicts
 *  that predate the axis (field absent) are undecidable, never a clean pass. */
function storedDetection(d: SimConversationMetrics["user_never_spoke"] | undefined): DetectionResult {
  if (!d || typeof d.detected !== "boolean") {
    return { detected: false, reason: "", technical_reason: "not present in the stored verdicts", available: false };
  }
  return { detected: d.detected, reason: d.reason ?? "", technical_reason: d.technical_reason ?? "", available: d.available !== false };
}

/** Pure with respect to `stored`: returns a new verdicts object whose
 *  conversation_metrics carry a fresh human_transfer + transfer_consent; every
 *  other field (node_evaluations, goals, the other detections) is the same
 *  value — node_evaluations by reference. */
export async function rejudgeTransferAxis(
  input: ConversationInput,
  stored: SessionEvalVerdicts,
  provider?: LlmProvider,
): Promise<SessionEvalVerdicts> {
  const cm = stored.conversation_metrics ?? ({} as SimConversationMetrics);
  const axis = await evaluateTransferAxis(input, storedDetection(cm.user_never_spoke), provider);
  return { ...stored, conversation_metrics: { ...cm, ...axis } };
}
