// Supervisor layer — decompose a stored verdict into per-judge "axis checks".
//
// Each axis check is one judge decision the supervisor will independently
// re-decide: the judge's verdict + reason, whether it "fired" (flagged a
// problem), the judge's own rubric (so the supervisor can suggest prompt
// fixes), and any per-node context. Conversation/goal axes carry node_ref="".

import {
  HALLUCINATION,
  VARIABLE_EXTRACTION,
  LOOP_DETECTION,
  INSTRUCTION_ADHERENCE,
  INTENT_IDENTIFICATION,
  GOAL_EVALUATION,
} from "../judges/instructions.js";
import {
  BOT,
  VOICEMAIL,
  CALL_SCREENING,
  LOW_ENGAGEMENT,
  WRONG_NUMBER,
  DO_NOT_DISTURB,
  USER_SENTIMENT,
} from "../judges/conversation-judges.js";
import type { ConversationInput, SessionEvalVerdicts } from "../types.js";

/** Stable axis keys used everywhere (DB, API, UI grouping) + display labels. */
export const AXIS_LABEL: Record<string, string> = {
  bot_detection: "Bot / IVR",
  voicemail: "Voicemail",
  call_screening: "Call Screening",
  low_engagement: "Low Engagement",
  wrong_number: "Wrong Number",
  do_not_disturb: "Do Not Disturb",
  user_sentiment: "User Sentiment",
  instructions_adherence: "Instruction Following",
  intent_identification: "Intent Identification",
  variable_extraction: "Variable Extraction",
  hallucination: "Hallucination",
  loop_detection: "Loop Detection",
  goal: "Goal",
};

export interface AxisCheck {
  axis: string;
  nodeRef: string;
  nodeName: string;
  /** Normalized judge verdict, e.g. "detected"/"not_detected" or "pass"/"fail". */
  judgeVerdict: string;
  judgeReason: string;
  /** True when the judge flagged a problem (detected / failed). Non-fired axes
   *  are only sampled for review; fired axes are always reviewed. */
  fired: boolean;
  /** The judge's own rubric text — fed to the supervisor so its prompt-fix
   *  suggestions reference the real prompt. */
  criteria: string;
  /** Extra per-axis context the judge had (node instructions, expected vars,
   *  available intents, goal name) so the supervisor re-decides on equal footing. */
  extraContext: string;
}

function nodeCtx(node: ConversationInput["nodes"][number] | undefined): string {
  if (!node) return "";
  const parts: string[] = [];
  if (node.node_prompt) parts.push(`Node instructions:\n${node.node_prompt}`);
  if (Array.isArray(node.available_intents) && node.available_intents.length)
    parts.push(`Available intents: ${node.available_intents.map((i) => i?.intent_name).filter(Boolean).join(", ")}`);
  if (Array.isArray(node.required_variables) && node.required_variables.length)
    parts.push(`Variables to extract: ${node.required_variables.join(", ")}`);
  return parts.join("\n\n");
}

/** Decompose a stored verdict + its built input into per-judge axis checks. */
export function buildAxisChecks(verdicts: SessionEvalVerdicts, input: ConversationInput): AxisCheck[] {
  const checks: AxisCheck[] = [];
  const cm = verdicts.conversation_metrics;

  // ── conversation axes (whole-transcript, self-contained criteria) ──────────
  const detection = (axis: string, criteria: string, d?: { detected: boolean; reason: string; available?: boolean }) => {
    if (!d || d.available === false) return; // judge didn't run → nothing to audit
    checks.push({
      axis, nodeRef: "", nodeName: "", criteria, extraContext: "",
      judgeVerdict: d.detected ? "detected" : "not_detected",
      judgeReason: d.reason ?? "",
      fired: d.detected === true,
    });
  };
  if (cm) {
    detection("bot_detection", BOT, cm.bot_detected);
    detection("voicemail", VOICEMAIL, cm.voicemail_detected);
    detection("call_screening", CALL_SCREENING, cm.call_screening);
    detection("low_engagement", LOW_ENGAGEMENT, cm.low_engagement);
    detection("wrong_number", WRONG_NUMBER, cm.wrong_number);
    detection("do_not_disturb", DO_NOT_DISTURB, cm.do_not_disturb);
    const s = cm.user_sentiment;
    if (s && s.available !== false && s.sentiment) {
      checks.push({
        axis: "user_sentiment", nodeRef: "", nodeName: "", criteria: USER_SENTIMENT, extraContext: "",
        judgeVerdict: s.sentiment, judgeReason: s.reason ?? "",
        fired: s.passed === false, // a "failing" sentiment (negative/confused)
      });
    }
  }

  // ── node axes (per node) ───────────────────────────────────────────────────
  const nodeByRef = new Map<string, ConversationInput["nodes"][number]>();
  for (const n of input.nodes) if (n.node_uuid) nodeByRef.set(n.node_uuid, n);
  for (const ne of verdicts.node_evaluations ?? []) {
    const ref = (ne as { ref?: string }).ref ?? ne.node_uuid ?? "";
    const name = ne.node_name || ref;
    const ctx = nodeCtx(nodeByRef.get(ref));
    const push = (axis: string, criteria: string, fired: boolean, verdict: string, reason: string) =>
      checks.push({ axis, nodeRef: ref, nodeName: name, criteria, extraContext: ctx, judgeVerdict: verdict, judgeReason: reason ?? "", fired });

    const ia = ne.instructions_adherence;
    if (ia) push("instructions_adherence", INSTRUCTION_ADHERENCE, ia.adherence_passed === false, ia.adherence_passed ? "pass" : "fail", ia.reason);
    const it = ne.intent_identification;
    if (it) { const f = !!(it.intent_not_found || it.intent_wrongly_identified); push("intent_identification", INTENT_IDENTIFICATION, f, f ? "fail" : "pass", it.reason); }
    const ve = ne.variable_extraction;
    if (ve) push("variable_extraction", VARIABLE_EXTRACTION, ve.extraction_successful === false, ve.extraction_successful ? "pass" : "fail", ve.reason);
    const h = ne.hallucination;
    if (h) push("hallucination", HALLUCINATION, h.hallucinated === true, h.hallucinated ? "detected" : "not_detected", h.reason);
    const lp = ne.node_loop;
    if (lp) push("loop_detection", LOOP_DETECTION, lp.loop_detected === true, lp.loop_detected ? "detected" : "not_detected", lp.reason);
  }

  // ── goal axis (one check per configured goal) ──────────────────────────────
  for (const g of verdicts.goal_evaluation?.goals ?? []) {
    checks.push({
      axis: "goal", nodeRef: g.goal_name || "goal", nodeName: g.goal_name || "",
      criteria: GOAL_EVALUATION, extraContext: `Goal: ${g.goal_name}`,
      judgeVerdict: g.achieved ? "achieved" : "not_achieved",
      judgeReason: g.reason ?? "",
      fired: g.achieved === false,
    });
  }

  return checks;
}
