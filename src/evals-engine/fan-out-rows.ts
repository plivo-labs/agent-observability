import type { SessionEvalVerdicts } from "./integration/session-evals.js";
import { sentimentPassed } from "./judges/conversation-judges.js";

export type ExternalEvalRow = {
  judgeName: string;
  tag: string | null;
  passed: boolean;
  reasoning: string;
  raw: Record<string, unknown>;
};

/**
 * Build the per-judge fan-out rows from a session's aggregate verdicts.
 *
 * Pure (no DB) so the row-SELECTION logic is unit-testable in isolation;
 * `fanOutExternalEvals` persists exactly what this returns. Detections read as
 * fail when they fire; judge-unavailable fallbacks (available===false) are
 * SKIPPED, never written as passes, so a provider outage can't bias fail rates.
 */
export function buildExternalEvalRows(verdicts: SessionEvalVerdicts): ExternalEvalRow[] {
  const rows: ExternalEvalRow[] = [];

  // SER-6035 (#3): machine-answered sessions (voicemail / bot / call-screening)
  // have no human conversation, so the node-level instruction-adherence judge
  // has no signal to grade — emitting a verdict is noise (this was the voicemail
  // false-fail). Skip ONLY adherence on those sessions; the conversation-axis
  // voicemail/bot judges below still record the outcome, and every other node
  // judge is unaffected. Gate on a CONFIDENT machine detection (detected===true),
  // never on an unavailable/failed classifier.
  const cm = verdicts.conversation_metrics;
  const machineAnswered = !!(
    cm &&
    (cm.voicemail_detected?.detected === true ||
      cm.bot_detected?.detected === true ||
      cm.call_screening?.detected === true)
  );

  for (const ne of verdicts.node_evaluations) {
    const tag = ne.ref || null;
    const ia = ne.instructions_adherence;
    if (ia && !machineAnswered) rows.push({ judgeName: "instructions_adherence", tag, passed: ia.adherence_passed, reasoning: ia.reason, raw: ia as any });
    const ii = ne.intent_identification;
    if (ii) rows.push({ judgeName: "intent_identification", tag, passed: !(ii.intent_not_found || ii.intent_wrongly_identified), reasoning: ii.reason, raw: ii as any });
    const ve = ne.variable_extraction;
    if (ve) rows.push({ judgeName: "variable_extraction", tag, passed: ve.extraction_successful, reasoning: ve.reason, raw: ve as any });
    const ha = ne.hallucination;
    if (ha) rows.push({ judgeName: "hallucination", tag, passed: !ha.hallucinated, reasoning: ha.reason, raw: ha as any });
    const lo = ne.node_loop;
    if (lo) rows.push({ judgeName: "node_loop", tag, passed: !lo.loop_detected, reasoning: lo.reason, raw: lo as any });
  }

  if (cm) {
    const detections: Array<[string, { detected: boolean; reason: string; available: boolean } | undefined]> = [
      ["voicemail_detection", cm.voicemail_detected],
      ["bot_detection", cm.bot_detected],
      ["call_screening", cm.call_screening],
      ["low_engagement", cm.low_engagement],
      ["wrong_number", cm.wrong_number],
      ["do_not_disturb", cm.do_not_disturb],
      // Code-derived signal judge: rides the same array so it reuses the
      // `available === false` skip below (an undecidable axis fans out nothing).
      ["user_never_spoke", cm.user_never_spoke],
      // Transfer axis. human_transfer is the FACT (fail = a transfer executed,
      // same detection convention as every row above); transfer_consent is the
      // JUDGEMENT (fail = it executed without consent; `raw.reason_code` says
      // why). Both unavailable on sessions with no transfer / no tag feed, so
      // they fan out nothing there — never a phantom pass.
      ["human_transfer", cm.human_transfer],
      ["transfer_consent", cm.transfer_consent],
    ];
    for (const [judgeName, det] of detections) {
      if (!det || typeof det.detected !== "boolean") continue;
      // Skip a judge that couldn't run (provider outage) — never fan an
      // unavailable detection out as a `pass`.
      if (det.available === false) continue;
      rows.push({ judgeName, tag: null, passed: !det.detected, reasoning: det.reason, raw: det as any });
    }
    const sentiment = cm.user_sentiment;
    const sentimentValue = sentiment?.sentiment ?? "";
    if (sentimentValue && sentimentValue !== "unknown" && sentiment?.available !== false) {
      rows.push({
        judgeName: "user_sentiment",
        tag: null,
        // The verdict carries the derived pass/fail; only fall back to the
        // rule (via sentimentPassed) for payloads that predate the field.
        passed: sentiment?.passed ?? sentimentPassed(sentimentValue),
        reasoning: sentiment?.reason ? `${sentimentValue}: ${sentiment.reason}` : sentimentValue,
        raw: sentiment as any,
      });
    }
  }

  for (const goal of verdicts.goal_evaluation?.goals ?? []) {
    rows.push({
      judgeName: goal.goal_name ? `goal:${goal.goal_name}` : "goal",
      tag: null,
      passed: goal.achieved,
      reasoning: goal.reason,
      raw: goal as any,
    });
  }

  return rows;
}
