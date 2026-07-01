import type { LlmProvider, LlmUsage } from "../../llm/index.js";
import type { ConversationInput, GoalInput, GoalEvaluation } from "../types.js";
import { GoalRawZ } from "./types.js";
import { systemForGoal } from "./instructions.js";
import { runLlmJudge } from "./run-llm-judge.js";
import { GOAL_JSON } from "./schemas.js";

// AO Eval Engine — goal evaluation judge (one LLM call for all goals). The caller (evaluator) only invokes
// this when goals.length > 0 (the cx-sqs gate; no goals ⇒ goal_evaluation omitted → UI "No goals configured").
// The LLM returns per-goal {achieved, reason, technical_reason}; we re-attach flow_goal_id from the input and
// default any goal the model skipped to not-achieved (cx-sqs behavior). cx-sqs token cap: 2000.

export async function runGoalJudge(
  goals: GoalInput[],
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ data: GoalEvaluation; usage: LlmUsage }> {
  const goalsText = goals.map((g) => `- ${g.goal_name}: ${g.goal_instructions}`).join("\n");
  const flowHistory = ctx.full_transcript || "(no transcript)";

  const res = await runLlmJudge({
    system: systemForGoal(goalsText, flowHistory),
    input: { flow_name: ctx.flow_name, goals: goals.map((g) => ({ goal_name: g.goal_name, goal_instructions: g.goal_instructions })) },
    schema: GoalRawZ,
    jsonSchema: GOAL_JSON,
    maxTokens: 2000,
    provider,
  });

  const byName = new Map(res.data.goals.map((g) => [g.goal_name.trim().toLowerCase(), g]));
  const evaluation: GoalEvaluation = {
    goals: goals.map((g) => {
      const hit = byName.get(g.goal_name.trim().toLowerCase());
      return {
        goal_name: g.goal_name,
        flow_goal_id: g.flow_goal_id,
        achieved: hit?.achieved ?? false,
        reason: hit?.reason ?? "Goal not evaluated by LLM",
        technical_reason: hit?.technical_reason ?? "",
      };
    }),
  };
  return { data: evaluation, usage: res.usage };
}
