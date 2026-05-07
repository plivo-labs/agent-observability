/**
 * Core judge runner: builds prompt, calls LLM once, parses result, records judgments.
 *
 * Sync target:
 *   plugins/pytest-agent-observability/src/pytest_agent_observability/judges/runner.py
 */

import { recordJudgment } from "../collector.js";
import { buildPrompt } from "./prompt.js";
import type { Rubric } from "./rubrics.js";

export interface LLMClient {
  evaluate(prompt: string): Promise<string>;
}

export interface JudgeInput {
  response: string;
  context?: string | string[];
  systemPrompt?: string;
  taskInstructions?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
}

export interface CriterionResult {
  name: string;
  score: number;
  reason: string;
  verdict: "pass" | "fail" | "maybe";
  threshold: number;
}

export async function evaluate({
  rubrics,
  input,
  llm,
  threshold = 0.7,
}: {
  rubrics: Rubric[];
  input: JudgeInput;
  llm: LLMClient;
  threshold?: number;
}): Promise<Record<string, CriterionResult>> {
  const prompt = buildPrompt(rubrics, input);
  const raw = await llm.evaluate(prompt);

  const parsed = parseJson(raw);
  if (parsed === null) {
    recordJudgment({
      intent: "judge_failed",
      name: "judge_failed",
      verdict: "fail",
      reasoning: raw,
    });
    return {};
  }

  const results: Record<string, CriterionResult> = {};
  for (const rubric of rubrics) {
    const entry = parsed[rubric.name];
    if (typeof entry !== "object" || entry === null) continue;
    const score = parseFloat(String(entry.score ?? 0));
    const reason = String(entry.reason ?? "");
    const verdict = score >= threshold ? "pass" : "fail";
    recordJudgment({
      intent: rubric.name,
      name: rubric.name,
      verdict,
      reasoning: reason,
      score,
      threshold,
    });
    results[rubric.name] = { name: rubric.name, score, reason, verdict, threshold };
  }

  return results;
}

function parseJson(raw: string): Record<string, any> | null {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
      return obj;
    }
  } catch {
    // fall through to regex extraction
  }

  const match = /\{.*\}/s.exec(raw);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        return obj;
      }
    } catch {
      // fall through
    }
  }

  return null;
}
