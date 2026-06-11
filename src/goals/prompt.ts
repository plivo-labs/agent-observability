/**
 * The goal-judge prompt and its structured-output schema.
 *
 * The schema is the contract generateObject validates against; the
 * analyzer additionally enforces verdicts.length === goals.length.
 */
import { z } from "zod";
import type { GoalSpec } from "./extract.js";

export const goalVerdictSchema = z.object({
  goals: z.array(
    z.object({
      met: z.boolean(),
      reasoning: z.string(),
      what_went_wrong: z.string().nullable(),
    }),
  ),
});

/**
 * Build the judge prompt for one session.
 *
 * Policy: STRICT, evidence-only. A goal is met only when the transcript
 * proves it — promises, intentions, and partial progress are unmet, and
 * ties break to unmet. Rationale: a false "met" hides a real production
 * failure, while a false "unmet" just earns a human glance, so the
 * judge errs toward unmet.
 *
 * @param transcript role-labeled lines ("caller: …" / "agent: …")
 * @param goals      named goals, in order; verdicts must come back in
 *                   the SAME order, one per goal. The description is
 *                   what gets judged; the name only labels it.
 * @param truncated  true when the transcript start was cut for length
 */
export function buildGoalJudgePrompt(
  transcript: string,
  goals: GoalSpec[],
  truncated: boolean,
): string {
  const goalLines = goals
    .map((g, i) =>
      g.description === g.name
        ? `${i + 1}. ${g.name}`
        : `${i + 1}. ${g.name}: ${g.description}`,
    )
    .join("\n");
  return [
    "You are a strict QA judge for voice-agent calls. For each goal below, decide whether the transcript PROVES the goal was met.",
    "",
    "Rules:",
    "- Judge only from the transcript. Nothing off-call may be assumed.",
    "- A goal is met only when the transcript shows it happening or being explicitly confirmed. Promises, intentions, and partial progress are unmet.",
    "- When in doubt, unmet.",
    '- "reasoning": one or two sentences citing the decisive moment of the call.',
    '- "what_went_wrong": null when met; otherwise one short sentence naming the missing or failed step.',
    "- Return exactly one verdict per goal, in the order listed.",
    truncated
      ? "- The start of the transcript was truncated for length; judge only what is shown."
      : "",
    "",
    "Goals:",
    goalLines,
    "",
    "Transcript:",
    transcript,
  ]
    .filter(Boolean)
    .join("\n");
}
