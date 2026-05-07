/**
 * Rubric definitions for LLM-as-judge evaluation.
 *
 * Methodology adapted from:
 *   cx-sqs-worker/usecases/vibe_eval/evaluator/prompt/configs.go
 *
 * Sync target — strings MUST match verbatim with:
 *   plugins/pytest-agent-observability/src/pytest_agent_observability/judges/rubrics.py
 */

export interface Rubric {
  name: string;
  criteria: string;
  steps: string[];
}

export const HALLUCINATION_RUBRIC: Rubric = {
  name: "hallucination",
  criteria:
    "Does the response contain fabricated claims not supported by any provided evidence? " +
    "Hallucination is strictly about factual accuracy — NOT formatting, style, or instruction compliance.",
  steps: [
    "Review the response in <response>.",
    "List all specific factual claims (names, numbers, dates, statuses, policies).",
    "For each claim, check against these evidence sources:",
    "  - <context>: Data or documents provided as grounding context.",
    "  - <system-prompt>: Policies, rules, and facts the agent is permitted to state.",
    "  - <conversation-history>: What was actually said in prior turns.",
    "A claim is hallucinated ONLY if it appears in NONE of these sources AND contradicts or goes beyond them.",
    "NOT hallucination: opinions, apologies, offers to help, or saying 'I don't know'.",
    "NOT hallucination: referencing facts or policies that appear in any evidence source.",
    "Score 1.0 if all claims are supported. Score 0.0 if critical facts are fabricated. Score 0.5-0.7 for minor unsupported details.",
  ],
};

export const ADHERENCE_RUBRIC: Rubric = {
  name: "adherence",
  criteria:
    "Does the response follow the system prompt and any task instructions provided? " +
    "Evaluate scope, goal progress, tone, safety, and consistency.",
  steps: [
    "Extract instructions from <system-prompt> (tone, policies, scope, safety rules).",
    "If <task-instructions> is provided, extract the specific guidance for this task.",
    "Review the response in <response>.",
    "SCOPE: Does the response stay within the intended purpose defined by the instructions?",
    "GOAL PROGRESS: Does the response advance toward the objective? Paraphrasing is acceptable if intent is preserved.",
    "TONE: Does the response match the required tone (e.g. professional, friendly) from the instructions?",
    "SAFETY: No policy violations or inappropriate content per the instructions.",
    "CONSISTENCY: No contradiction with prior messages in <conversation-history>.",
    "Score 1.0 if all criteria are met. Score 0.5-0.7 for minor violations. Score 0.0 for major violations.",
  ],
};
