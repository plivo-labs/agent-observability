/**
 * Build the combined LLM judge prompt for one or more rubrics.
 *
 * Sync target:
 *   plugins/pytest-agent-observability/src/pytest_agent_observability/judges/prompt.py
 */

import type { Rubric } from "./rubrics.js";
import type { JudgeInput } from "./runner.js";

export function buildPrompt(rubrics: Rubric[], input: JudgeInput): string {
  const sections: string[] = [];

  sections.push(
    "You are an objective evaluator. Assess the agent response below against each " +
      "rubric criterion and return ONLY a JSON object. No prose outside the JSON.\n" +
      "Response format:\n" +
      '{"<rubric_name>": {"score": <float 0.0-1.0>, "reason": "<brief explanation>"}, ...}',
  );

  // Input slots — omit empty
  if (input.systemPrompt) {
    sections.push(`<system_prompt>\n${input.systemPrompt}\n</system_prompt>`);
  }

  if (input.taskInstructions) {
    sections.push(
      `<task_instructions>\n${input.taskInstructions}\n</task_instructions>`,
    );
  }

  if (input.context) {
    const ctx = Array.isArray(input.context)
      ? input.context.join("\n")
      : input.context;
    sections.push(`<context>\n${ctx}\n</context>`);
  }

  if (input.conversationHistory && input.conversationHistory.length > 0) {
    const historyText = JSON.stringify(input.conversationHistory, null, 2);
    sections.push(
      `<conversation_history>\n${historyText}\n</conversation_history>`,
    );
  }

  sections.push(`<agent_response>\n${input.response}\n</agent_response>`);

  // Rubric definitions
  for (const rubric of rubrics) {
    const stepsText = rubric.steps
      .map((s, i) => `  ${i + 1}. ${s}`)
      .join("\n");
    sections.push(
      `<rubric name="${rubric.name}">\n` +
        `Criteria: ${rubric.criteria}\n` +
        `Evaluation steps:\n${stepsText}\n` +
        `</rubric>`,
    );
  }

  sections.push(
    "Now produce the JSON evaluation object for the rubric(s) above. " +
      "Use the exact rubric names as keys.",
  );

  return sections.join("\n\n");
}
