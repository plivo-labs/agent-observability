#!/usr/bin/env bun
// Score candidate wordings for ONE conversation question the way the PIPELINE
// emits the verdict, not the way the raw probability reads.
// AO decides some axes in code before any judge verdict exists — a voice call
// with zero caller turns IS low engagement — so scoring the raw answer measures
// something the product never emits. Every variant rides ONE request per
// session over the same state, so a sweep costs one request per call, not one
// per call per variant.
//
//   TYPESAFE_API_KEY=... bun scripts/jev-tune-question.ts \
//     <dir of session dossiers> <gt.json> <variants.json> [out.json] [limit]
//
// `<dir of session dossiers>` and `<gt.json>` come from a benchmark dataset
// produced outside this repo.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eventsFromChatHistory } from "../src/evals-engine/eval-sweeper.js";
import { buildSessionEvalInput, type AgentConfig } from "../src/evals-engine/integration/session-evals.js";
import { jevConversationState } from "../src/evals-engine/jev/plan.js";
import { CONVERSATION_QUESTIONS, noul } from "../src/jev/questions.js";
import { HttpJevClient } from "../src/jev/client.js";
import { estimateRequestTokens } from "../src/jev/tokens.js";

const CALLS = process.argv[2]!;
const GT = process.argv[3]!;
const VARIANTS = process.argv[4]!;
const OUT = process.argv[5] ?? "/tmp/le-tune.json";
const LIMIT = Number(process.argv[6] ?? "0") || Infinity;

type Variant = { name: string; instructions: string; criteria_true: string; criteria_false: string };
const variants: Variant[] = JSON.parse(await readFile(VARIANTS, "utf8"));
const gt: Record<string, Record<string, boolean>> = JSON.parse(await readFile(GT, "utf8"));
const files = (await readdir(CALLS)).filter((f) => f.endsWith(".json")).slice(0, LIMIT === Infinity ? undefined : LIMIT);

const questions: Record<string, ReturnType<typeof noul>> = { baseline: CONVERSATION_QUESTIONS.low_engagement! };
for (const v of variants) questions[`v.${v.name}`] = noul(v.instructions, v.criteria_true, v.criteria_false);

const client = new HttpJevClient({ apiKey: process.env.TYPESAFE_API_KEY!, model: "jev-1.13.0", timeoutMs: 60_000, maxConcurrent: 6 });
const rows: Array<{ id: string; silent: boolean; truth: boolean; p: Record<string, number> }> = [];
let done = 0;

const queue = [...files];
await Promise.all(Array.from({ length: 6 }, async () => {
  for (;;) {
    const file = queue.shift();
    if (!file) return;
    const dossier = JSON.parse(await readFile(path.join(CALLS, file), "utf8"));
    const id: string = dossier.session_id;
    if (!gt[id] || gt[id].low_engagement === undefined) continue;
    const { input } = buildSessionEvalInput(dossier.agent_config as AgentConfig, eventsFromChatHistory(dossier.transcript));
    if (!input.full_transcript.trim()) continue;
    const state = jevConversationState(input);
    const est = estimateRequestTokens(state, questions);
    try {
      const res = await client.systemOne({ key: id.slice(0, 8), state, questions, estTokens: est.longest, estTotalTokens: est.total });
      const p: Record<string, number> = {};
      for (const k of Object.keys(questions)) if (res.answers[k]) p[k] = res.answers[k]!.noul;
      // AO's code rule: a voice call with zero caller turns where the agent
      // asked a question is low engagement, decided before any judge verdict.
      const speech = (input.speech_transcript || input.full_transcript).split("\n");
      const answered = speech.some((l) => /^User:\s*\S/.test(l));
      const agentAsked = speech.some((l) => l.startsWith("Agent:") && l.includes("?"));
      rows.push({ id, silent: !answered && agentAsked, truth: !!gt[id].low_engagement, p });
    } catch (e) {
      console.error(`  skip ${id.slice(0, 8)}: ${(e as Error).message}`);
    }
    if (++done % 25 === 0) console.error(`  ${done}/${files.length}`);
  }
}));

await writeFile(OUT, JSON.stringify(rows, null, 1));

const score = (flags: boolean[], truth: boolean[]) => {
  let tp = 0, fp = 0, fn = 0;
  flags.forEach((f, i) => { if (f && truth[i]) tp++; else if (f) fp++; else if (truth[i]) fn++; });
  const prec = tp + fp ? (tp / (tp + fp)) * 100 : NaN;
  const rec = tp + fn ? (tp / (tp + fn)) * 100 : NaN;
  const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
  return { f1, prec, rec, fp, fn };
};
const truth = rows.map((r) => r.truth);
console.log(`\n${rows.length} sessions (${rows.filter((r) => r.silent).length} decided in code)\n`);
console.log(`${"question".padEnd(28)}${"F1".padStart(7)}${"prec".padStart(7)}${"rec".padStart(7)}${"FP".padStart(5)}${"FN".padStart(5)}   ${"raw F1".padStart(7)}`);
for (const key of Object.keys(questions)) {
  const emitted = rows.map((r) => r.silent || (r.p[key] ?? 0) >= 0.5);
  const raw = rows.map((r) => (r.p[key] ?? 0) >= 0.5);
  const e = score(emitted, truth), rw = score(raw, truth);
  console.log(
    key.padEnd(28) + e.f1.toFixed(1).padStart(7) + e.prec.toFixed(1).padStart(7) + e.rec.toFixed(1).padStart(7) +
      String(e.fp).padStart(5) + String(e.fn).padStart(5) + "   " + rw.f1.toFixed(1).padStart(7),
  );
}
