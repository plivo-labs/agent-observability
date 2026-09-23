#!/usr/bin/env bun
/**
 * Replay gate: run the SHIPPED TypeScript path (buildSessionEvalInput ->
 * buildJevPlan -> the real Jev client -> gatePlan) over the benchmark sessions
 * and compare, per judge, with the probabilities the tuning harness measured.
 *
 * This proves the PORT, not the model: the questions, the states and the
 * aggregation must reproduce the numbers the gates were set from. Jev's own
 * run-to-run noise is |dp| <= ~0.07, so band agreement is the metric and dp is
 * reported alongside it.
 *
 * `--calls` and `--tuned` point at a benchmark dataset produced OUTSIDE this
 * repo (one session dossier per JSON file, plus the probabilities the tuning
 * harness measured), so the paths are yours to supply:
 *
 *   TYPESAFE_API_KEY=... bun scripts/jev-replay.ts \
 *     --calls <dir of session dossiers> \
 *     --tuned <tuned_flags.json> \
 *     --out /tmp/jev-replay.jsonl [--limit 50] [--concurrency 4]
 */
import { readdir, readFile, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eventsFromChatHistory } from "../src/evals-engine/eval-sweeper.js";
import { buildSessionEvalInput, type AgentConfig } from "../src/evals-engine/integration/session-evals.js";
import { buildJevPlan } from "../src/evals-engine/jev/plan.js";
import { gatePlan, mergeChunkedAxes, type RequestResult } from "../src/evals-engine/jev/gate.js";
import { DEFAULT_GATES, decide } from "../src/jev/gates.js";
import { HttpJevClient } from "../src/jev/client.js";

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : (fallback ?? "");
};

/** tuned_flags.json dimension -> the judge name this code uses. */
const DIM_TO_JUDGE: Record<string, string> = {
  node_loop: "node_loop",
  instructions_adherence: "instructions_adherence",
  intent_identification: "intent_identification",
  variable_extraction: "variable_extraction",
  hallucination: "hallucination",
  voicemail_detected: "voicemail_detection",
  bot_detected: "bot_detection",
  call_screening: "call_screening",
  low_engagement: "low_engagement",
  wrong_number: "wrong_number",
  do_not_disturb: "do_not_disturb",
};

async function main(): Promise<void> {
  const callsDir = arg("calls");
  const tunedPath = arg("tuned");
  const outPath = arg("out", "/tmp/jev-replay.jsonl");
  const limit = Number(arg("limit", "0")) || Infinity;
  const concurrency = Number(arg("concurrency", "4"));
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required");

  const tuned: Record<string, Record<string, number>> = JSON.parse(await readFile(tunedPath, "utf8"));
  const files = (await readdir(callsDir)).filter((f) => f.endsWith(".json")).slice(0, limit === Infinity ? undefined : limit);
  await writeFile(outPath, "");

  const client = new HttpJevClient({ apiKey, model: process.env.JEV_MODEL ?? "jev-1.13.0", timeoutMs: 60_000, maxConcurrent: 8 });
  let done = 0;

  const runOne = async (file: string): Promise<void> => {
    const dossier = JSON.parse(await readFile(path.join(callsDir, file), "utf8"));
    const sessionId: string = dossier.session_id;
    const events = eventsFromChatHistory(dossier.transcript);
    const { input } = buildSessionEvalInput(dossier.agent_config as AgentConfig, events);
    const plan = buildJevPlan(input);
    const results = new Map<string, RequestResult>();
    await Promise.all(
      plan.requests.map(async (request) => {
        try {
          results.set(request.key, { ok: true, response: await client.systemOne(request) });
        } catch (error) {
          results.set(request.key, { ok: false, error });
        }
      }),
    );
    const gated = mergeChunkedAxes(gatePlan(plan, results, DEFAULT_GATES));
    // Some axes are decided in CODE before any judge verdict is emitted (a
    // voice call with zero caller turns IS low engagement, resolveOutcomes).
    // Scoring the raw probability instead of the emitted verdict once produced
    // a wrong call on low_engagement, so the flag is recorded here.
    const speech = (input.speech_transcript || input.full_transcript).split("\n");
    const silentCall = !speech.some((l) => /^User:\s*\S/.test(l)) && speech.some((l) => l.startsWith("Agent:") && l.includes("?"));
    // tuned_flags stores ONE probability per judge per session (the max across
    // that judge's questions AND nodes), so collapse the same way.
    const byJudge: Record<string, { p: number | null; fallback?: string }> = {};
    for (const g of gated) {
      const current = byJudge[g.axis.judge];
      if (!current || (g.p ?? -1) > (current.p ?? -1)) byJudge[g.axis.judge] = { p: g.p, ...(g.fallback ? { fallback: g.fallback } : {}) };
    }
    await appendFile(
      outPath,
      JSON.stringify({
        session_id: sessionId,
        nodes: input.nodes.length,
        requests: plan.requests.map((r) => ({ key: r.key, est: r.estTotalTokens, longest: r.estTokens, real: (results.get(r.key) as any)?.response?.usage?.input_tokens ?? null })),
        dropped: plan.dropped,
        silent_call: silentCall,
        errors: [...results].filter(([, r]) => !r.ok).map(([k, r]) => [k, String((r as any).error?.message ?? "")]),
        judges: byJudge,
      }) + "\n",
    );
    done++;
    if (done % 10 === 0) console.error(`  ${done}/${files.length}`);
  };

  const queue = [...files];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        try {
          await runOne(next);
        } catch (e) {
          console.error(`  skip ${next}: ${(e as Error).message}`);
        }
      }
    }),
  );

  // ── report ────────────────────────────────────────────────────────────────
  const lines = (await readFile(outPath, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const stats: Record<string, { n: number; agree: number; dpSum: number; dpMax: number; onlyHere: number; onlyTuned: number }> = {};
  let estOver = 0, estUnder = 0, ratioMax = 0, requests = 0, errors = 0, dropped = 0;
  for (const line of lines) {
    for (const r of line.requests) {
      requests++;
      if (r.real) {
        const ratio = r.real / r.est;
        ratioMax = Math.max(ratioMax, ratio);
        if (ratio > 1) estUnder++; else estOver++;
      }
    }
    errors += line.errors.length;
    dropped += line.dropped.length;
    const tunedRow = tuned[line.session_id];
    if (!tunedRow) continue;
    for (const [dim, judge] of Object.entries(DIM_TO_JUDGE)) {
      const tunedP = tunedRow[dim];
      const mine = line.judges[judge]?.p;
      const s = (stats[judge] ??= { n: 0, agree: 0, dpSum: 0, dpMax: 0, onlyHere: 0, onlyTuned: 0 });
      if (tunedP === undefined && mine === undefined) continue;
      if (tunedP === undefined) { s.onlyHere++; continue; }
      if (mine === undefined || mine === null) { s.onlyTuned++; continue; }
      const gate = DEFAULT_GATES[judge]!;
      s.n++;
      // The code rule outranks the judge on this axis, so compare what would
      // actually be emitted.
      const forced = judge === "low_engagement" && line.silent_call;
      if (forced || decide(mine, gate) === decide(tunedP, gate)) s.agree++;
      const dp = Math.abs(mine - tunedP);
      s.dpSum += dp;
      s.dpMax = Math.max(s.dpMax, dp);
    }
  }
  console.log(`\nsessions ${lines.length} · requests ${requests} · jev errors ${errors} · over-budget ${dropped}`);
  console.log(`token estimate vs real: under-estimated on ${estUnder}/${estUnder + estOver} requests, worst real/est ratio ${ratioMax.toFixed(2)}`);
  console.log(`\n${"judge".padEnd(24)}${"n".padStart(5)}${"band agree".padStart(12)}${"mean dp".padStart(10)}${"max dp".padStart(9)}${"only-here".padStart(11)}${"only-tuned".padStart(12)}`);
  for (const [judge, s] of Object.entries(stats)) {
    const agree = s.n ? ((s.agree / s.n) * 100).toFixed(1) + "%" : "-";
    console.log(
      judge.padEnd(24) + String(s.n).padStart(5) + agree.padStart(12) +
        (s.n ? (s.dpSum / s.n).toFixed(3) : "-").padStart(10) + (s.n ? s.dpMax.toFixed(2) : "-").padStart(9) +
        String(s.onlyHere).padStart(11) + String(s.onlyTuned).padStart(12),
    );
  }
}

await main();
