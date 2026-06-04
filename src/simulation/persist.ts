/* persist.ts — map a finished simulation into the eval data model and store it,
 * so sim runs show up in the Evals tab. Shared by the /api/simulations route
 * and the scheduler. */
import { randomUUID } from "crypto";
import { insertEvalRun } from "../evals/db.js";
import type { EvalPayloadV0 } from "../evals/schema.js";
import type { CallResult, SimResult } from "./engine.js";

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
      judgments: c.judge?.criteria?.length
        ? c.judge.criteria.map((cr) => ({ name: cr.name, verdict: cr.pass ? "pass" : "fail", reasoning: cr.justification }))
        : [{ name: "leveled_judge", scope: "flow", verdict: c.status, score: c.score, reasoning: c.summary }],
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
        judgments: c.judge.criteria.map((cr) => ({ name: cr.name, verdict: cr.pass ? "pass" : "fail", reasoning: cr.justification })),
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
        judgments: result.judge.criteria.map((c) => ({ name: c.name, verdict: c.pass ? "pass" : "fail", reasoning: c.justification })),
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
