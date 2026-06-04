/* persist.ts — map a finished simulation into the eval data model and store it,
 * so sim runs show up in the Evals tab. Shared by the /api/simulations route
 * and the scheduler. */
import { randomUUID } from "crypto";
import { insertEvalRun } from "../evals/db.js";
import type { EvalPayloadV0 } from "../evals/schema.js";
import type { CallResult, JudgeScopes, SimResult } from "./engine.js";

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
      rows.push({ name: a.label, scope: `agent:${a.agent_id}`, verdict: a.overall, score: a.score, reasoning: scopeReason(a.criteria, a.label) });
    }
    // task — one row per task segment (carry the segment start as `turn`).
    for (const t of scopes.task ?? []) {
      rows.push({ name: t.label, scope: `task:${t.task_id}`, verdict: t.overall, score: t.score, turn: t.turn_range?.[0], reasoning: scopeReason(t.criteria, t.label) });
    }
    // node — one row per assistant turn (turn-anchored).
    for (const n of scopes.node ?? []) {
      rows.push({ name: `turn ${n.turn_index}`, scope: `node:${n.turn_index}`, verdict: n.overall, turn: n.turn_index, reasoning: scopeReason(n.criteria, n.text?.slice(0, 80) ?? "") });
    }
    return rows;
  }
  if (criteria?.length) {
    return criteria.map((cr) => ({ name: cr.name, verdict: cr.pass ? "pass" : "fail", reasoning: cr.justification }));
  }
  return [{ name: "leveled_judge", scope: "flow", verdict: status, score, reasoning: summary }];
}

function scopeReason(crits: { name: string; pass: boolean; justification: string }[], fallback: string): string {
  if (!crits?.length) return fallback;
  const failing = crits.filter((c) => !c.pass);
  const src = failing.length ? failing : crits;
  return src.map((c) => c.justification).filter(Boolean).join(" ") || fallback;
}

/* Compact full-report blob persisted onto eval_runs.sim_report, so the Evals
 * run-detail page can render a simulation's complete report later. Pulled
 * straight off SimResult. Passed DIRECTLY into `${value}::jsonb` downstream
 * (never JSON.stringify'd before ::jsonb) per the CLAUDE.md gotcha. */
function buildSimReport(result: SimResult): Record<string, unknown> {
  // Per-case leveled-judge trees keyed by persona/case name, so the Evals
  // run-detail can render the SELECTED persona's tree (not just the worst-case
  // `judgeTree`). The EvalCaseRow.name === SimCaseResult.personaName, so the
  // run-detail page looks the tree up by the selected case's name. Older runs
  // won't have this key → the page falls back to `judgeTree`.
  const caseTrees: Record<string, unknown> = {};
  for (const c of result.cases) if (c.judgeTree) caseTrees[c.personaName] = c.judgeTree;
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
      sim_report: buildSimReport(result),
    },
    cases: result.cases.map((c) => ({
      case_id: randomUUID(),
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

// A batch of live calls (a Truman "suite") → one eval run, one case per call.
export async function persistCallBatch(agentName: string, calls: CallResult[]): Promise<string | null> {
  if (!calls.length) return null;
  try {
    const finished = Math.floor(Date.now() / 1000);
    const totalDur = calls.reduce((a, c) => a + c.durationS, 0);
    const payload: EvalPayloadV0 = {
      version: "v0",
      run: {
        run_id: randomUUID(),
        account_id: null,
        agent_id: agentName,
        framework: "livekit",
        framework_version: null,
        testing_framework: "live-call",
        testing_framework_version: calls[0].engine,
        started_at: finished - totalDur,
        finished_at: finished,
        ci: null,
      },
      cases: calls.map((c) => ({
        case_id: randomUUID(),
        name: c.personaName,
        file: c.personaType,
        status: c.verdict === "pass" ? "passed" : "failed",
        started_at: null,
        finished_at: null,
        duration_ms: c.durationS * 1000,
        user_input: c.opener,
        events: c.transcript.map((t) => ({ type: "message", role: t.role === "agent" ? "assistant" : "user", content: t.t, ms: t.ms, flag: t.flag })),
        judgments: buildJudgments({ scopes: c.judge.scopes, criteria: c.judge.criteria, status: c.verdict, summary: c.judge.notes }),
        failure: c.verdict === "fail" ? { message: c.judge.notes, type: "CriteriaFailed" } : null,
        // Live calls carry a Truman run id → proxy the recording so the Evals
        // page can play each call. Null for demo/text-sim cases (no real audio).
        recording_url: c.trumanRunId ? `/api/calls/audio/${c.trumanRunId}` : null,
      })),
    };
    await insertEvalRun(payload);
    return payload.run.run_id;
  } catch (e) {
    console.error(`[call] batch persist failed: ${(e as Error).message}`);
    return null;
  }
}

// A single live call → one eval run with one case, judged by criteria.
export async function persistCallRun(result: CallResult): Promise<string | null> {
  try {
    const finished = Math.floor(Date.now() / 1000);
    const payload: EvalPayloadV0 = {
      version: "v0",
      run: {
        run_id: randomUUID(),
        account_id: null,
        agent_id: result.agentName,
        framework: "livekit",
        framework_version: null,
        testing_framework: "live-call",
        testing_framework_version: result.engine,
        started_at: finished - result.durationS,
        finished_at: finished,
        ci: null,
      },
      cases: [{
        case_id: randomUUID(),
        name: result.personaName,
        file: result.personaType,
        status: result.verdict === "pass" ? "passed" : "failed",
        started_at: null,
        finished_at: null,
        duration_ms: result.durationS * 1000,
        user_input: result.opener,
        events: result.transcript.map((t) => ({ type: "message", role: t.role === "agent" ? "assistant" : "user", content: t.t, ms: t.ms, flag: t.flag })),
        judgments: buildJudgments({ scopes: result.judge.scopes, criteria: result.judge.criteria, status: result.verdict, summary: result.judge.notes }),
        failure: result.verdict === "fail" ? { message: result.judge.notes, type: "CriteriaFailed" } : null,
        recording_url: result.trumanRunId ? `/api/calls/audio/${result.trumanRunId}` : null,
      }],
    };
    await insertEvalRun(payload);
    return payload.run.run_id;
  } catch (e) {
    console.error(`[call] could not persist to evals: ${(e as Error).message}`);
    return null;
  }
}
