// Supervisor layer — re-decide one axis check with an independent model and, on
// disagreement (a misflag), propose a minimal judge-prompt fix.
//
// Normalizes every axis to a boolean "problem_present" so agreement is uniform:
//   agreement = (supervisor says problem present) === (judge fired).
// N-vote self-consistency: sample the model EVAL_REVIEW_VOTES times (temperature
// > 0 so votes are genuinely independent); the majority wins.

import { z } from "zod";
import { completeJSON } from "../../llm/index.js";
import { config } from "../../config.js";
import { AXIS_LABEL, type AxisCheck } from "./axes.js";

const VoteZ = z.object({
  problem_present: z.boolean(),
  reason: z.string(),
  suggested_add: z.array(z.string()).default([]),
  suggested_remove: z.array(z.string()).default([]),
  rationale: z.string().default(""),
});
type Vote = z.infer<typeof VoteZ>;

export interface AxisReview {
  axis: string;
  nodeRef: string;
  nodeName: string;
  originalVerdict: string;   // "flagged" | "clear"
  originalReason: string;
  supervisorVerdict: string; // "flagged" | "clear"
  supervisorReason: string;
  agreement: boolean;        // false = MISFLAG
  votesFor: number;
  votesTotal: number;
  suggestedFix: { add: string[]; remove: string[]; rationale: string } | null;
  model: string;
}

function reviewModel(): string {
  return config.EVAL_REVIEW_MODEL || config.JUDGE_MODEL || "";
}

function buildPrompt(check: AxisCheck, flowName: string, transcript: string): { system: string; prompt: string } {
  const label = AXIS_LABEL[check.axis] ?? check.axis;
  const system =
    `You are a SUPERVISOR auditing an automated evaluation judge for the "${label}" check. ` +
    `You are given the judge's exact rubric, the conversation, and the judge's decision. ` +
    `Independently apply the rubric and decide whether a problem is genuinely present — do NOT defer to the judge. ` +
    `Set problem_present=true if the rubric's condition IS met on this conversation, false otherwise. ` +
    `If (and only if) you DISAGREE with the judge, propose the MINIMAL edit to the judge's rubric that would fix this class of error: ` +
    `specific lines to ADD and/or existing lines to REMOVE, with a one-line rationale. ` +
    `Return ONLY JSON: {"problem_present": boolean, "reason": string, "suggested_add": string[], "suggested_remove": string[], "rationale": string}.`;

  const prompt = [
    `## Judge rubric ("${label}")`,
    check.criteria,
    check.extraContext ? `\n## Context the judge had\n${check.extraContext}` : "",
    `\n## Conversation (flow: ${flowName})`,
    transcript || "(empty transcript)",
    `\n## The judge's decision`,
    `The judge ${check.fired ? "FLAGGED a problem" : "did NOT flag a problem"} for this session.`,
    `Judge's stated verdict: ${check.judgeVerdict}`,
    `Judge's reason: ${check.judgeReason || "(none)"}`,
  ].join("\n");

  return { system, prompt };
}

/** Re-decide one axis check via N-vote and, on disagreement, aggregate a fix. */
export async function reviewAxis(check: AxisCheck, flowName: string, transcript: string): Promise<AxisReview> {
  const model = reviewModel();
  const votesTotal = Math.max(1, config.EVAL_REVIEW_VOTES);
  const { system, prompt } = buildPrompt(check, flowName, transcript);

  const votes: Vote[] = [];
  for (let i = 0; i < votesTotal; i++) {
    try {
      const { data } = await completeJSON({
        schema: VoteZ,
        role: "judge",
        model,
        system,
        prompt,
        maxTokens: 1200,
        // >0 so N votes are independent samples (self-consistency); the judges
        // run at 0, but the supervisor deliberately wants variance to surface flakiness.
        temperature: votesTotal > 1 ? 0.4 : 0,
        maxRetries: 1,
      });
      votes.push(data);
    } catch {
      /* a dropped vote just lowers votesTotal-effective; skip it */
    }
  }

  const effective = votes.length || 1;
  const problemVotes = votes.filter((v) => v.problem_present).length;
  const supervisorProblem = problemVotes * 2 >= effective; // majority (ties → problem, conservative)
  const votesFor = supervisorProblem ? problemVotes : effective - problemVotes;

  const agreement = supervisorProblem === check.fired;
  const majoritySide = votes.filter((v) => v.problem_present === supervisorProblem);
  const pickReason = majoritySide.find((v) => v.reason)?.reason ?? votes[0]?.reason ?? "";

  let suggestedFix: AxisReview["suggestedFix"] = null;
  if (!agreement) {
    // Aggregate the fixes from the votes that disagreed with the judge.
    const add = [...new Set(majoritySide.flatMap((v) => v.suggested_add).filter(Boolean))].slice(0, 6);
    const remove = [...new Set(majoritySide.flatMap((v) => v.suggested_remove).filter(Boolean))].slice(0, 6);
    const rationale = majoritySide.find((v) => v.rationale)?.rationale ?? "";
    suggestedFix = { add, remove, rationale };
  }

  return {
    axis: check.axis,
    nodeRef: check.nodeRef,
    nodeName: check.nodeName,
    originalVerdict: check.fired ? "flagged" : "clear",
    originalReason: check.judgeReason,
    supervisorVerdict: supervisorProblem ? "flagged" : "clear",
    supervisorReason: pickReason,
    agreement,
    votesFor,
    votesTotal: effective,
    suggestedFix,
    model,
  };
}
