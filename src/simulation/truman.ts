/* truman.ts — Truman caller API client for REAL Live calls.
 *
 * AO orchestrates Truman over HTTP (LiveKit/PSTN can't run in Bun): it
 * provisions Truman entities from the AO Library selections, creates a Truman
 * SUITE (one run per persona), then polls the runs. Truman judges the real
 * transcript against the rubric we push in, so AO ingests the verdict directly.
 *
 * Semantic mapping (important):
 *   • AO `prompt` (agent-under-test system prompt) → Truman Agent.description +
 *     persona context. Truman dials a real phone; it can't inject the prompt
 *     into the external agent, so the prompt is only context for the persona/judge.
 *   • AO persona (goal/opener/name/type) → Truman Persona.prompt.
 *   • AO criteria → Truman Rubric (criterion `name` → Truman `key`; the judge
 *     echoes `name`=`key`, so it round-trips into AO judge.criteria[].name).
 *   • Truman transcript roles are INVERTED vs AO: the LiveKit agent IS the
 *     persona/caller ("assistant"→AO 'user'); the callee under test is "user"→AO 'agent'.
 */
import { createHash } from "crypto";
import { config } from "../config.js";
import { sql } from "../db.js";
import { deriveAgentName, type CallResult, type Criterion, type CriterionVerdict, type Turn } from "./engine.js";

const base = () => (config.TRUMAN_API_URL ?? "").replace(/\/$/, "");
const fp = (obj: unknown) => createHash("sha1").update(JSON.stringify(obj)).digest("hex").slice(0, 16);

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

/** Liveness preflight — used before placing a suite so we fail loudly (not fake). */
export async function trumanHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch { return false; }
}

/* ---------- idempotent entity provisioning (dedup via sim_truman_map) ---------- */
async function ensureMapped(kind: string, aoKey: string, fingerprint: string, create: () => Promise<string>): Promise<string> {
  const [hit] = await sql`
    SELECT truman_id FROM sim_truman_map
    WHERE ao_kind = ${kind} AND ao_key = ${aoKey} AND fingerprint = ${fingerprint} LIMIT 1`;
  if (hit?.truman_id) return hit.truman_id as string;
  const id = await create();
  // Best-effort cache; ON CONFLICT guards the rare concurrent-provision race.
  await sql`
    INSERT INTO sim_truman_map (ao_kind, ao_key, fingerprint, truman_id)
    VALUES (${kind}, ${aoKey}, ${fingerprint}, ${id})
    ON CONFLICT (ao_kind, ao_key, fingerprint) DO NOTHING`;
  return id;
}

function personaPrompt(p: any, agentName: string, agentPrompt: string): string {
  const type = String(p.type ?? "baseline").replace(/_/g, " ");
  const ctx = agentPrompt?.trim() ? `\n\nContext about the agent you are calling:\n${agentPrompt.trim()}` : "";
  return [
    `You are role-playing a caller named "${p.name}" (${type}) phoning ${agentName}.`,
    `Your goal: ${p.goal ?? "interact with the agent"}.`,
    `Stay fully in character for the entire call. Speak naturally, like a real person on the phone. Never break character or reveal that you are an AI or a test.${ctx}`,
  ].join("\n");
}

export interface ProvisionedRun { trumanRunId: string; persona: any }
export interface ProvisionedSuite { trumanSuiteId: string; agentName: string; runs: ProvisionedRun[] }

/** Create Truman agent + per-persona persona/scenario + a shared rubric, then a suite. */
export async function provisionSuite(input: {
  prompt: string; phoneNumber: string; personas: any[]; criteria: Criterion[]; opener?: string;
  rubricId?: string; rubricName?: string;
}): Promise<ProvisionedSuite> {
  const { prompt, phoneNumber, personas, criteria, opener } = input;
  if (!phoneNumber?.trim()) throw new Error("a phone number is required for real calls");
  if (!personas.length) throw new Error("select at least one persona");
  if (personas.length > 20) throw new Error("a real-call suite supports at most 20 personas");

  const agentName = deriveAgentName(prompt);

  // Agent (dial target). Keyed by phone so the same number reuses one Truman agent.
  const trumanAgentId = await ensureMapped(
    "agent", phoneNumber.trim(), fp({ agentName, phoneNumber, prompt }),
    () => tFetch("/v1/agents", { method: "POST", body: { name: agentName, phone_number: phoneNumber.trim(), description: prompt?.slice(0, 2000) || agentName } }).then((r) => r.id),
  );

  // Rubric (shared across the suite). Truman requires a non-empty criteria list.
  const effCriteria: Criterion[] = criteria.length ? criteria
    : [{ name: "Task completion", question: "Did the agent complete the caller's requested task?" }];
  const trumanCriteria = effCriteria.map((c) => ({ key: c.name, question: c.question || c.name, weight: c.weight ?? 1 }));
  const rubricName = input.rubricName || "AO criteria";
  const rubricAoKey = input.rubricId || `crit:${fp(trumanCriteria)}`;
  const trumanRubricId = await ensureMapped(
    "rubric", rubricAoKey, fp({ trumanCriteria, model: config.TRUMAN_JUDGE_MODEL }),
    () => tFetch("/v1/rubrics", { method: "POST", body: { name: rubricName, criteria: trumanCriteria, judge_model: config.TRUMAN_JUDGE_MODEL } }).then((r) => r.id),
  );

  // Per-persona persona + scenario.
  const scenarioToPersona = new Map<string, any>();
  const scenarioIds: string[] = [];
  for (const p of personas) {
    const pPrompt = personaPrompt(p, agentName, prompt);
    const personaAoKey = p.id ? String(p.id) : `inline:${fp(p)}`;
    const trumanPersonaId = await ensureMapped(
      "persona", personaAoKey, fp({ pPrompt, voice: config.TRUMAN_DEFAULT_VOICE_ID }),
      () => tFetch("/v1/personas", { method: "POST", body: { name: String(p.name ?? "Caller").slice(0, 120), prompt: pPrompt, voice_id: config.TRUMAN_DEFAULT_VOICE_ID } }).then((r) => r.id),
    );
    const openerText = (opener?.trim() || p.opener || `Open the call naturally as ${p.name}.`).slice(0, 1000);
    const scenarioFp = fp({ a: trumanAgentId, p: trumanPersonaId, r: trumanRubricId, openerText });
    const trumanScenarioId = await ensureMapped(
      "scenario", `${personaAoKey}::${rubricAoKey}`, scenarioFp,
      () => tFetch("/v1/scenarios", { method: "POST", body: {
        name: `${agentName} × ${p.name}`.slice(0, 120),
        agent_id: trumanAgentId, persona_id: trumanPersonaId, rubric_id: trumanRubricId,
        opener_instructions: openerText,
      } }).then((r) => r.id),
    );
    scenarioIds.push(trumanScenarioId);
    scenarioToPersona.set(trumanScenarioId, p);
  }

  // Suite = one run per scenario.
  const suite = await tFetch("/v1/suites", { method: "POST", body: {
    agent_id: trumanAgentId, scenario_ids: scenarioIds, name: `${agentName} — AO Live suite`.slice(0, 120),
  } });
  const runs: ProvisionedRun[] = (suite.runs ?? []).map((r: any) => ({
    trumanRunId: r.id,
    persona: scenarioToPersona.get(r.scenario_id) ?? {},
  }));
  return { trumanSuiteId: suite.id, agentName, runs };
}

export async function getRun(runId: string): Promise<any> {
  return tFetch(`/v1/runs/${runId}`);
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

/* Director controls (Bearer-authed POSTs; empty body). */
export const takeoverStart = (runId: string) => tFetch(`/v1/runs/${runId}/takeover/start`, { method: "POST" });
export const takeoverStop = (runId: string) => tFetch(`/v1/runs/${runId}/takeover/stop`, { method: "POST" });
export const endCall = (runId: string) => tFetch(`/v1/runs/${runId}/end-call`, { method: "POST" });

/** Stream a finished run's recording through AO (so the Truman token isn't exposed). */
export async function trumanAudioUpstream(runId: string): Promise<Response> {
  return fetch(`${base()}/v1/runs/${runId}/audio.ogg?token=${encodeURIComponent(config.TRUMAN_API_TOKEN ?? "")}`, {
    signal: AbortSignal.timeout(30_000),
  });
}

const TERMINAL = new Set(["done", "failed"]);
export const isTerminal = (status?: string) => !!status && TERMINAL.has(status);

/** Map a Truman RunRead → the fields AO needs to build a CallResult. */
export function mapRun(run: any): {
  status: string; verdict: "pass" | "fail" | null;
  judge: CallResult["judge"] | null; transcript: Turn[]; cost: CallResult["cost"];
  durationS: number; recordingUrl: string | null; error: string | null;
  // The caller agent's LiveKit per-turn metrics, ridden into runs.usage by the
  // Truman caller (chat_history + session_metrics). AO turns these into a
  // Monitor session per call. null when the caller didn't emit them.
  sessionChatHistory: any[] | null; sessionMetrics: any | null;
  startedAt: string | null; endedAt: string | null;
} {
  const status = String(run?.status ?? "queued");
  const jr = run?.judge_result;
  const judge = jr && Array.isArray(jr.criteria)
    ? {
        criteria: jr.criteria.map((c: any) => ({ name: String(c.name ?? c.key ?? ""), pass: !!c.pass, justification: String(c.justification ?? "") })),
        overall: (jr.overall === "pass" ? "pass" : "fail") as "pass" | "fail",
        notes: String(jr.notes ?? ""),
      }
    : null;
  const verdict = run?.verdict === "pass" ? "pass" : run?.verdict === "fail" ? "fail" : null;
  const cost = mapUsage(run?.usage, run?.started_at, run?.ended_at);
  return {
    status,
    verdict,
    judge,
    transcript: parseTranscript(run?.transcript_text),
    cost,
    durationS: cost.call_seconds,
    recordingUrl: status === "done" ? `/api/calls/audio/${run.id}` : null,
    error: run?.error ?? null,
    sessionChatHistory: (run?.usage?.chat_history as any[]) ?? null,
    sessionMetrics: (run?.usage?.session_metrics as any) ?? null,
    startedAt: run?.started_at ?? null,
    endedAt: run?.ended_at ?? null,
  };
}

/** Build an AO Monitor `chat_history` from the caller agent's serialized history.
 *
 * The Monitor session represents the **caller agent** (the synthetic persona),
 * because the per-turn metrics it carries ARE the caller agent's: its STT/EOU on
 * the callee's input (on `user` items) and its LLM/TTS on its own replies (on
 * `assistant` items). That is exactly the role↔metric layout AO's metrics.ts
 * expects, so we keep the caller agent's own roles (no inversion) — inverting
 * would mismatch metrics to roles and drop turn_decision_ms. The `metrics`
 * object is already AO-shaped (LiveKit MetricsReport field names, in seconds);
 * item ids are preserved so `session_metrics.per_turn` token entries line up.
 * (The dialed agent-under-test is a black box over PSTN; its internal latencies
 * aren't observable — see the Live call's transcript/judge for that side.) */
export function buildMonitorChatHistory(callerHistory: any[] | null): any[] {
  return (callerHistory ?? [])
    .filter((i) => (i.type ?? "message") === "message")
    .map((i) => ({
      id: i.id,
      type: "message",
      role: i.role === "assistant" ? "assistant" : "user",
      content: typeof i.content === "string" ? i.content : Array.isArray(i.content) ? i.content.join(" ") : String(i.content ?? ""),
      interrupted: !!i.interrupted,
      transcript_confidence: i.transcript_confidence,
      metrics: i.metrics ?? undefined,
    }));
}

function mapUsage(usage: any, startedAt?: string, endedAt?: string): CallResult["cost"] {
  const u = usage || {};
  const llm = u.llm || {}, tts = u.tts || {}, stt = u.stt || {}, plivo = u.plivo || {};
  let call_seconds = Math.round(Number(plivo.seconds ?? plivo.audio_seconds ?? 0));
  if (!call_seconds && startedAt && endedAt) {
    const d = (Date.parse(endedAt) - Date.parse(startedAt)) / 1000;
    if (Number.isFinite(d) && d > 0) call_seconds = Math.round(d);
  }
  const cents = u.total_cents != null
    ? Math.round(Number(u.total_cents) * 10) / 10
    : Math.round(((llm.cents || 0) + (tts.cents || 0) + (stt.cents || 0) + (plivo.cents || 0)) * 10) / 10;
  return {
    llm_tokens: Math.round((llm.input_tokens || 0) + (llm.output_tokens || 0)),
    tts_chars: Math.round(tts.chars || 0),
    stt_seconds: Math.round(stt.audio_seconds || 0),
    call_seconds,
    cents,
  };
}

// Truman roles → AO roles. Persona/caller = "assistant" → AO 'user'; callee
// under test = "user" → AO 'agent'; human takeover = "director".
function mapRole(label: string, t: string): Turn {
  const l = label.toLowerCase().trim();
  if (l === "assistant" || l === "persona" || l === "caller" || l === "speaker_1") return { role: "user", t };
  if (l === "director") return { role: "user", t, flag: "director" };
  return { role: "agent", t }; // "user"/"agent"/"callee"/"speaker_0"/unknown
}

/** Parse Truman's `transcript_text` into AO Turn[]. It's JSONL ({"role","text","ts"}
 *  per line, the live transcript) or — from a Deepgram recording — diarized
 *  `speaker_N:` / `role:` lines. Handle both. */
function parseTranscript(text: unknown): Turn[] {
  if (!text || typeof text !== "string") return [];
  const out: Turn[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("{")) {
      // JSONL line: {"role": "...", "text": "...", "ts": n}
      try {
        const o = JSON.parse(line);
        const t = String(o.text ?? o.transcript ?? "").trim();
        if (t) out.push(mapRole(String(o.role ?? o.speaker ?? ""), t));
        continue;
      } catch { /* fall through to label parse */ }
    }
    const m = line.match(/^([A-Za-z0-9_ ]+?):\s*(.*)$/);
    if (!m) { out.push({ role: "agent", t: line }); continue; }
    out.push(mapRole(m[1], m[2]));
  }
  return out;
}
