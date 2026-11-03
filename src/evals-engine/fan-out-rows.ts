import type { SessionEvalVerdicts } from "./integration/session-evals.js";
import { sentimentPassed } from "./judges/conversation-judges.js";
import { isJudgeError, type JudgeErrorMarker } from "./judge-error.js";

export type ExternalEvalRow = {
  judgeName: string;
  tag: string | null;
  passed: boolean;
  /** Overrides the pass/fail verdict text — custom metrics write 'unknown'
   *  for calls that never reached the judged situation, which must count as
   *  neither a pass nor a fail. */
  verdictText?: string;
  reasoning: string;
  raw: Record<string, unknown>;
};

/**
 * Build the per-judge fan-out rows from a session's aggregate verdicts.
 *
 * Pure (no DB) so the row-SELECTION logic is unit-testable in isolation;
 * `fanOutExternalEvals` persists exactly what this returns. Detections read as
 * fail when they fire; skipped or undecidable axes (available===false) are
 * SKIPPED, never written as passes; an axis whose judge failed is written as
 * `unknown`, neither. So a judge failure can't bias fail rates.
 */
export function buildExternalEvalRows(verdicts: SessionEvalVerdicts): ExternalEvalRow[] {
  const rows: ExternalEvalRow[] = [];
  const judgeErrorRow = (judgeName: string, tag: string | null, axis: { reason: string }): ExternalEvalRow =>
    ({ judgeName, tag, passed: false, verdictText: "unknown", reasoning: axis.reason, raw: axis as any });

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
    const push = <T extends { reason: string }>(judgeName: string, axis: T | undefined, passed: (a: Exclude<T, JudgeErrorMarker>) => boolean) => {
      if (!axis) return;
      if (isJudgeError(axis)) rows.push(judgeErrorRow(judgeName, tag, axis));
      else rows.push({ judgeName, tag, passed: passed(axis as Exclude<T, JudgeErrorMarker>), reasoning: axis.reason, raw: axis as any });
    };
    if (!machineAnswered) push("instructions_adherence", ne.instructions_adherence, (ia) => ia.adherence_passed);
    push("intent_identification", ne.intent_identification, (ii) => !(ii.intent_not_found || ii.intent_wrongly_identified));
    push("variable_extraction", ne.variable_extraction, (ve) => ve.extraction_successful);
    push("hallucination", ne.hallucination, (ha) => !ha.hallucinated);
    push("node_loop", ne.node_loop, (lo) => !lo.loop_detected);
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
      // The transfer FACT (fail = a transfer executed, same detection
      // convention as every row above). Unavailable on sessions with no
      // transfer tag, so it fans out nothing there — never a phantom pass.
      ["human_transfer", cm.human_transfer],
    ];
    for (const [judgeName, det] of detections) {
      if (!det || typeof det.detected !== "boolean") continue;
      if (isJudgeError(det)) {
        rows.push(judgeErrorRow(judgeName, null, det));
        continue;
      }
      // A skipped or undecidable detection fans out nothing — never a `pass`.
      if (det.available === false) continue;
      rows.push({ judgeName, tag: null, passed: !det.detected, reasoning: det.reason, raw: det as any });
    }
    const sentiment = cm.user_sentiment;
    const sentimentValue = sentiment?.sentiment ?? "";
    if (isJudgeError(sentiment)) rows.push(judgeErrorRow("user_sentiment", null, sentiment));
    else if (sentimentValue && sentimentValue !== "unknown" && sentiment?.available !== false) {
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

  for (const cm of verdicts.custom_metrics ?? []) {
    // A skipped judge fans out nothing; a failed one reaches the unknown row below.
    if (!cm.available && !isJudgeError(cm)) continue;
    if (cm.scope === "node" && cm.per_node) {
      for (const n of cm.per_node) {
        rows.push({
          judgeName: cm.judge_name,
          tag: n.ref || null,
          passed: n.verdict === "pass",
          ...(n.verdict === "unknown" ? { verdictText: "unknown" } : {}),
          reasoning: n.reason,
          raw: n as unknown as Record<string, unknown>,
        });
      }
      continue;
    }
    rows.push({
      judgeName: cm.judge_name,
      tag: null,
      passed: cm.verdict === "pass",
      ...(cm.verdict === "unknown" ? { verdictText: "unknown" } : {}),
      reasoning: cm.reason,
      raw: cm as unknown as Record<string, unknown>,
    });
  }

  return rows;
}
