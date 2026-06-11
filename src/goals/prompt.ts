/**
 * The goal-judge prompt and its structured-output schema.
 *
 * The schema is the contract generateObject validates against; the
 * analyzer additionally enforces verdicts.length === goals.length.
 */
import { z } from "zod";

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
 * TODO(amal): this prompt is a product decision — strictness, how to
 * treat partially-met goals, what counts as evidence. The placeholder
 * below is functional but deliberately unopinionated; replace it with
 * the policy you want the judge to apply.
 *
 * @param transcript role-labeled lines ("caller: …" / "agent: …")
 * @param goals      plain-text goals, in order; verdicts must come back
 *                   in the SAME order, one per goal
 * @param truncated  true when the transcript start was cut for length
 */
export function buildGoalJudgePrompt(
  transcript: string,
  goals: string[],
  truncated: boolean,
): string {
  const goalLines = goals.map((g, i) => `${i + 1}. ${g}`).join("\n");
  return [
    "You evaluate a recorded conversation between a caller and a voice agent.",
    "For each goal listed below, decide whether the conversation shows the goal was met.",
    "Return one verdict per goal, in the same order as listed.",
    'For each: "met" (boolean), "reasoning" (one or two sentences citing what happened),',
    'and "what_went_wrong" (null when met; otherwise a short description of what prevented it).',
    truncated
      ? "Note: the transcript was truncated for length — only the latter part of the call is shown."
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
