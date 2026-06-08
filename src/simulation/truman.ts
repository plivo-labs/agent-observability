/* truman.ts — Truman judge client (LiveKit eval judges via Truman /v1/judge).
 *
 * Simulate routes its judging through LiveKit's eval judges, which run behind
 * Truman's HTTP API. AO sends the generated transcript + criteria; Truman runs
 * `livekit.agents.evals` (one judge per criterion) and returns a per-criterion
 * verdict. This module is the thin HTTP client for that judge endpoint.
 *
 * Semantic mapping: AO criteria `name` → Truman `key`; the judge echoes
 * `name`=`key`, so it round-trips into AO judge.criteria[].name.
 */
import { config } from "../config.js";
import { type Criterion, type CriterionVerdict } from "./engine.js";

const base = () => (config.TRUMAN_API_URL ?? "").replace(/\/$/, "");

async function tFetch(path: string, opts: { method?: string; body?: unknown } = {}): Promise<any> {
  const res = await fetch(`${base()}${path}`, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.TRUMAN_API_TOKEN}` },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    let detail = String(res.status);
    try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
    throw new Error(`Truman ${opts.method ?? "GET"} ${path} → ${detail}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Judge a transcript with LiveKit's judges via Truman's POST /v1/judge.
 *  Maps AO criteria {name,question,weight} → Truman {key,question,weight} and
 *  returns AO's {criteria, overall, notes} verdict shape. */
export async function judgeTranscript(
  transcript: string,
  criteria: Criterion[],
): Promise<{ criteria: CriterionVerdict[]; overall: "pass" | "fail"; notes: string }> {
  const body = {
    transcript,
    criteria: criteria.map((c) => ({ key: c.name, question: c.question || c.name, weight: c.weight ?? 1 })),
  };
  const jr = await tFetch("/v1/judge", { method: "POST", body });
  return {
    criteria: Array.isArray(jr?.criteria)
      ? jr.criteria.map((c: any) => ({ name: String(c.name ?? c.key ?? ""), pass: !!c.pass, justification: String(c.justification ?? "") }))
      : [],
    overall: jr?.overall === "pass" ? "pass" : "fail",
    notes: String(jr?.notes ?? ""),
  };
}
