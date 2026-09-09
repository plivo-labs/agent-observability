// One content-aware MockLLM responder for every default judge: routes on a
// DISTINCTIVE phrase of each judge's criteria body and returns a minimal valid
// JSON for that judge's schema. Centralized so a prompt rewording breaks ONE
// fixture, not a copy in every suite. Compose with judge-specific branches by
// checking your own markers first and falling through to this.
export function defaultJudgeResponder(system: string): string | null {
  if (system.includes("fabricated information"))
    return JSON.stringify({ hallucinated: false, score: 1, reason: "", technical_reason: "" });
  if (system.includes("Variables expected to be extracted"))
    return JSON.stringify({ extraction_successful: true, score: 1, reason: "", technical_reason: "", missing_variables: [], incorrect_variables: [] });
  if (system.includes("repeat its own previous messages"))
    return JSON.stringify({ loop_detected: false, score: 1, reason: "", technical_reason: "" });
  if (system.includes("correct intent for the conversation segment"))
    return JSON.stringify({ intent_not_found: false, intent_wrongly_identified: false, reason: "", technical_reason: "" });
  if (system.includes("four-part rubric"))
    return JSON.stringify({
      objective_progress: { achieved: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
      procedure_compliance: { score: 1, missed_steps: [], reason_code: "", reason: "", technical_reason: "" },
      interaction_quality: { score: 1, issues: [], reason_code: "", reason: "", technical_reason: "" },
      policy_boundary_compliance: { passed: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
    });
  if (system.includes("Classify the user's sentiment"))
    return JSON.stringify({ sentiment: "neutral", reason: "r", technical_reason: "t" });
  if (system.includes("speech-to-text quality"))
    return JSON.stringify({ error_count: 0, recovered_count: 0, reason: "r", technical_reason: "t" });
  if (system.includes("Detect ")) // the six boolean detections share this skeleton
    return JSON.stringify({ detected: false, reason: "r", technical_reason: "t" });
  return null;
}
