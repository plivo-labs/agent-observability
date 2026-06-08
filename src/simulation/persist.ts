/* persist.ts — map a finished simulation into the eval data model and store it,
 * so sim runs show up in the Evals tab. Shared by the /api/simulations route
 * and the scheduler. */
import { randomUUID } from "crypto";
import { insertEvalRun } from "../evals/db.js";
import type { EvalPayloadV0 } from "../evals/schema.js";
import type { JudgeScopes, SimResult } from "./engine.js";
import { verdictOf } from "./engine.js";

/* Build eval_case judgments[] for a judged case. These are loose JSON (the
 * Evals schema stores them as-is), so we just include a `scope` tag on each row.
 *
 *   • Leveled (a `scopes` block is present): emit ONE flat SCOPE-TAGGED row per
 *     scope verdict — scope ∈ {flow, 'agent:<id>', 'task:<id>', 'node:<turn>'} —
 *     with verdict + reasoning (+ optional turn). This is the flat shape the
 *     Evals tab renders per-row.
 *   • No scopes (today's behavior): emit the flat per-criterion rows, or a
 *     single synthetic flow row when there are no criteria.
 *
 * NOTE: the returned array is passed DIRECTLY into `${value}::jsonb` downstream
 * (never JSON.stringify'd before ::jsonb) per the CLAUDE.md gotcha. */
function buildJudgments(input: {
  scopes?: JudgeScopes;
  criteria?: { name: string; pass: boolean; justification: string }[];
  status: "pass" | "fail";
  score?: number;
  summary: string;
}): Record<string, unknown>[] {
  const { scopes, criteria, status, score, summary } = input;
  if (scopes) {
    const rows: Record<string, unknown>[] = [];
    // flow — whole conversation (== today's top-level result). Always present
    // per the judge contract; guard defensively in case a block omits it.
    if (scopes.flow) {
      rows.push({ name: "flow", scope: "flow", verdict: scopes.flow.overall, score: scopes.flow.score, reasoning: summary || `${scopes.flow.score}/100` });
    }
    // agent — one row per agent partition.
    for (const a of scopes.agent ?? []) {
      rows.push({ name: a.label, scope: `agent:${a.agent_id}`, verdict: a.overall, score: a.score, reasoning: verdictOf(a.criteria, a.label) });
    }
    // task — one row per task segment (carry the segment start as `turn`).
    for (const t of scopes.task ?? []) {
      rows.push({ name: t.label, scope: `task:${t.task_id}`, verdict: t.overall, score: t.score, turn: t.turn_range?.[0], reasoning: verdictOf(t.criteria, t.label) });
    }
    // node — one row per assistant turn (turn-anchored).
    for (const n of scopes.node ?? []) {
      // Display the turn 1-based to match the judge-tree UI (`turn_index + 1`);
      // the numeric `turn` + `scope` id stay 0-based for range matching.
      rows.push({ name: `turn ${n.turn_index + 1}`, scope: `node:${n.turn_index}`, verdict: n.overall, turn: n.turn_index, reasoning: verdictOf(n.criteria, n.text?.slice(0, 80) ?? "") });
    }
    return rows;
  }
  if (criteria?.length) {
    return criteria.map((cr) => ({ name: cr.name, verdict: cr.pass ? "pass" : "fail", reasoning: cr.justification }));
  }
  return [{ name: "leveled_judge", scope: "flow", verdict: status, score, reasoning: summary }];
}

/* Compact full-report blob persisted onto eval_runs.sim_report, so the Evals
 * run-detail page can render a simulation's complete report later. Pulled
 * straight off SimResult. Passed DIRECTLY into `${value}::jsonb` downstream
 * (never JSON.stringify'd before ::jsonb) per the CLAUDE.md gotcha.
 *
 * `caseIds` maps each case's index → its persisted `case_id`, so `caseTrees`
 * is keyed by the SAME stable `case_id` the eval_cases rows use (the consumer
 * looks the tree up by `EvalCaseRow.case_id`). Keying by persona NAME used to
 * collide when two personas shared a name. */
function buildSimReport(result: SimResult, caseIds: string[]): Record<string, unknown> {
  // Per-case leveled-judge trees keyed by `case_id` (== EvalCaseRow.case_id),
  // so the Evals run-detail can render the SELECTED persona's tree (not just the
  // worst-case `judgeTree`). Older runs won't have this key → the page falls
  // back to `judgeTree`.
  const caseTrees: Record<string, unknown> = {};
  result.cases.forEach((c, i) => { if (c.judgeTree) caseTrees[caseIds[i]] = c.judgeTree; });
  return {
    overallScore: result.overall,
    passRate: result.total ? result.passN / result.total : 0,
    threshold: result.threshold,
    rubricAxes: result.rubricAxes,
    worstMoments: result.worstMoments,
    fixes: result.fixes,
    judgeTree: result.judgeTree,
    caseTrees,
    engine: result.engine,
    personaCount: result.cases.length,
  };
}

export function simResultToEvalPayload(result: SimResult): EvalPayloadV0 {
  const finished = Math.floor(Date.now() / 1000);
  const totalDur = result.cases.reduce((a, c) => a + (c.durationS || 0), 0);
  // Mint each case's id up-front so `sim_report.caseTrees` can be keyed by the
  // same `case_id` the eval_cases rows carry (producer ↔ consumer key match).
  const caseIds = result.cases.map(() => randomUUID());
  return {
    version: "v0",
    run: {
      run_id: randomUUID(),
      account_id: null,
      agent_id: result.agentName,
      framework: null,
      framework_version: null,
      testing_framework: "simulation",
      testing_framework_version: result.engine,
      started_at: finished - totalDur,
      finished_at: finished,
      ci: null,
      sim_report: buildSimReport(result, caseIds),
    },
    cases: result.cases.map((c, i) => ({
      case_id: caseIds[i],
      name: c.personaName,
      file: c.personaType,
      status: (c.status === "pass" ? "passed" : "failed") as "passed" | "failed",
      started_at: null,
      finished_at: null,
      duration_ms: Math.round((c.durationS || 0) * 1000),
      user_input: c.transcript.find((t) => t.role === "user")?.t ?? null,
      events: c.transcript.map((t) => ({ type: "message", role: t.role === "agent" ? "assistant" : "user", content: t.t, ms: t.ms, flag: t.flag })),
      judgments: buildJudgments({ scopes: c.judge?.scopes, criteria: c.judge?.criteria, status: c.status, score: c.score, summary: c.summary }),
      failure: c.status === "fail" ? { message: c.transcript.find((t) => t.flag)?.flag ?? c.summary, type: "PolicyOrQuality" } : null,
    })),
  };
}

export async function persistSimRun(result: SimResult): Promise<string | null> {
  try {
    const payload = simResultToEvalPayload(result);
    await insertEvalRun(payload);
    return payload.run.run_id;
  } catch (e) {
    console.error(`[sim] could not persist to evals: ${(e as Error).message}`);
    return null;
  }
}
