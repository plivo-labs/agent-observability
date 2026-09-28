import { createHash } from "node:crypto";
import { z } from "zod";
import type { LlmProvider } from "../../src/llm/types.js";
import type { JevClient } from "../../src/jev/types.js";
import { evaluateIngestedSession, type AgentConfig, type StoredEvent } from "../../src/evals-engine/integration/session-evals.js";
import { buildExternalEvalRows, type ExternalEvalRow } from "../../src/evals-engine/fan-out-rows.js";
import type { CustomJudgeSpec } from "../../src/evals-engine/judges/custom-metric.js";

const VerdictSchema = z.enum(["pass", "fail", "unknown", "absent"]);
type Verdict = z.infer<typeof VerdictSchema>;
const rowKey = (judgeName: string, tag: string | null) => JSON.stringify([judgeName, tag]);
const LabelSchema = z.object({ judgeName: z.string().min(1), tag: z.string().nullable(), verdict: VerdictSchema });
const CaseSchema = z.object({
  id: z.string().min(1), groupId: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  events: z.array(z.record(z.string(), z.unknown())),
  transport: z.string().optional(),
  tags: z.array(z.object({ name: z.string(), metadata: z.record(z.string(), z.unknown()).nullable() })).optional(),
  customJudges: z.array(z.object({
    name: z.string(), display_name: z.string(), scope: z.enum(["node", "conversation"]), body: z.string(), output: z.string(), max_tokens: z.number().int().positive().optional(),
  })).default([]),
  expected: z.array(LabelSchema).min(1),
}).superRefine((c, ctx) => {
  const keys = c.expected.map(l => rowKey(l.judgeName, l.tag));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Duplicate judge/node label" });
});

export const DatasetSchema = z.object({
  schemaVersion: z.literal(1), datasetId: z.string().min(1), labelRevision: z.string().min(1),
  split: z.enum(["synthetic", "calibration", "validation"]), reviewer: z.string().min(1),
  cases: z.array(CaseSchema).min(1),
}).superRefine((d, ctx) => {
  if (new Set(d.cases.map(c => c.id)).size !== d.cases.length) ctx.addIssue({ code: "custom", message: "Duplicate case id" });
});
export type ValidationDataset = z.infer<typeof DatasetSchema>;

export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const UsageSchema = z.object({ jevRequests: z.number(), llmCalls: z.number(), jevInputTokens: z.number(), jevOutputTokens: z.number(), llmInputTokens: z.number(), llmOutputTokens: z.number() });
const RowSchema = z.object({ judgeName: z.string(), tag: z.string().nullable(), passed: z.boolean(), verdictText: z.string().optional(), reasoning: z.string(), raw: z.record(z.string(), z.unknown()) });
export const RunSchema = z.object({
  schemaVersion: z.literal(1), datasetFingerprint: z.string(), revision: z.string(), settings: z.record(z.string(), z.unknown()),
  startedAt: z.string(), cases: z.array(z.object({
    id: z.string(), durationMs: z.number(), usage: UsageSchema, rows: z.array(RowSchema),
    // Full aggregate retains unavailable and suppressed candidates for investigation.
    aggregate: z.unknown().optional(), error: z.string().optional(),
  })),
});
export type ValidationRun = z.infer<typeof RunSchema>;

/** Production entry point all the way through final row selection. Providers are
 * injected so synthetic regression tests never need credentials or paid calls. */
export async function runValidation(dataset: ValidationDataset, opts: {
  jev?: JevClient; llm: LlmProvider; revision: string; settings: Record<string, unknown>;
}): Promise<ValidationRun> {
  const cases: ValidationRun["cases"] = [];
  const startedAt = new Date().toISOString();
  for (const c of dataset.cases) {
    const usage = { jevRequests: 0, llmCalls: 0, jevInputTokens: 0, jevOutputTokens: 0, llmInputTokens: 0, llmOutputTokens: 0 };
    const llm: LlmProvider = { name: opts.llm.name, async complete(args) {
      usage.llmCalls++;
      const result = await opts.llm.complete(args);
      usage.llmInputTokens += result.usage.promptTokens;
      usage.llmOutputTokens += result.usage.completionTokens;
      return result;
    } };
    const jev: JevClient | undefined = opts.jev ? { name: opts.jev.name, async systemOne(args) {
      usage.jevRequests++;
      const result = await opts.jev!.systemOne(args);
      usage.jevInputTokens += result.usage.input_tokens;
      usage.jevOutputTokens += result.usage.output_tokens;
      return result;
    } } : undefined;
    const start = performance.now();
    try {
      const aggregate = await evaluateIngestedSession(c.config as AgentConfig, c.events as StoredEvent[], llm, c.transport, undefined, c.tags, c.customJudges as CustomJudgeSpec[], jev);
      cases.push({ id: c.id, durationMs: performance.now() - start, usage, rows: buildExternalEvalRows(aggregate), aggregate });
    } catch (error) {
      // An error is missing output, never an invented pass. Continue the dataset
      // so one provider failure does not erase the remaining evaluation results.
      cases.push({ id: c.id, durationMs: performance.now() - start, usage, rows: [], error: String(error) });
    }
  }
  return { schemaVersion: 1, datasetFingerprint: fingerprint(dataset), revision: opts.revision, settings: opts.settings, startedAt, cases };
}

function verdictOf(row: ExternalEvalRow | undefined): Verdict {
  return !row ? "absent" : row.verdictText === "unknown" ? "unknown" : row.passed ? "pass" : "fail";
}
const newCounts = () => ({ labelled: 0, binaryLabels: 0, matches: 0, falsePasses: 0, falseFailures: 0, unknown: 0, missing: 0, autoPasses: 0, wrongAutoPasses: 0, reviewedCandidates: 0, candidateOverrides: 0, confusion: {} as Record<string, number> });
const rate = (n: number, d: number) => d ? n / d : null;

/** Score FINAL emitted rows, preserving absent/unknown and unlabelled outputs.
 * Labels never enter model prompts. A fingerprint mismatch requires a fresh run. */
export function summarizeValidation(dataset: ValidationDataset, run: ValidationRun) {
  if (run.datasetFingerprint !== fingerprint(dataset)) throw new Error("Run dataset fingerprint does not match inputs/label revision");
  if (run.cases.length !== dataset.cases.length || new Set(run.cases.map(c => c.id)).size !== run.cases.length ||
      run.cases.some(c => !dataset.cases.some(d => d.id === c.id))) throw new Error("Run must contain exactly one result for each dataset case");
  const results = new Map(run.cases.map(c => [c.id, c]));
  const perJudge: Record<string, ReturnType<typeof newCounts>> = {};
  const mismatches: Array<{ caseId: string; judgeName: string; tag: string | null; expected: Verdict; actual: Verdict }> = [];
  let unlabelledRows = 0;
  const versions = new Set<string>();
  for (const c of dataset.cases) {
    const result = results.get(c.id)!;
    const keys = result.rows.map(r => rowKey(r.judgeName, r.tag));
    if (new Set(keys).size !== keys.length) throw new Error(`Duplicate emitted judge/node row in ${c.id}`);
    const rows = new Map(result.rows.map(r => [rowKey(r.judgeName, r.tag), r]));
    const labelledKeys = new Set(c.expected.map(l => rowKey(l.judgeName, l.tag)));
    unlabelledRows += result.rows.filter(r => !labelledKeys.has(rowKey(r.judgeName, r.tag))).length;
    for (const row of result.rows) {
      const j = row.raw.jev as Record<string, unknown> | undefined;
      if (j) versions.add(JSON.stringify({ model: row.raw.jev_model, evidence: j.evidence_version, questions: j.question_version, policy: j.policy_version, gate: j.gate, judge: row.judgeName }));
    }
    for (const label of c.expected) {
      const row = rows.get(rowKey(label.judgeName, label.tag));
      const actual = verdictOf(row);
      const counts = perJudge[label.judgeName] ??= newCounts();
      counts.labelled++;
      const binary = label.verdict === "pass" || label.verdict === "fail";
      if (binary) counts.binaryLabels++;
      const pair = `${label.verdict}->${actual}`;
      counts.confusion[pair] = (counts.confusion[pair] ?? 0) + 1;
      if (actual === label.verdict) counts.matches++;
      else mismatches.push({ caseId: c.id, judgeName: label.judgeName, tag: label.tag, expected: label.verdict, actual });
      if (actual === "pass" && label.verdict === "fail") counts.falsePasses++;
      if (actual === "fail" && label.verdict === "pass") counts.falseFailures++;
      if (actual === "unknown") counts.unknown++;
      if (actual === "absent") counts.missing++;
      if (binary && actual === "pass" && row?.raw.backend === "jev") {
        counts.autoPasses++;
        if (label.verdict !== "pass") counts.wrongAutoPasses++;
      }
      const candidate = (row?.raw.jev as Record<string, unknown> | undefined)?.candidate;
      if (row?.raw.backend === "llm" && (candidate === "pass" || candidate === "fail" || candidate === "unknown")) {
        counts.reviewedCandidates++;
        if (actual !== candidate) counts.candidateOverrides++;
      }
    }
  }
  const times = run.cases.map(c => c.durationMs).sort((a, b) => a - b);
  const percentile = (p: number) => times[Math.max(0, Math.ceil(times.length * p) - 1)] ?? null;
  return {
    datasetId: dataset.datasetId, labelRevision: dataset.labelRevision, split: dataset.split, reviewer: dataset.reviewer,
    datasetFingerprint: run.datasetFingerprint, revision: run.revision, settings: run.settings,
    // Metadata cannot prove label independence or statistical adequacy.
    accuracyClaimAllowed: false,
    validationNote: "Inspect independent label quality, held-out groups and per-judge sample sizes before making accuracy claims.",
    sessions: run.cases.length, groups: new Set(dataset.cases.map(c => c.groupId)).size,
    failedSessions: run.cases.filter(c => c.error).map(c => c.id), unlabelledRows, mismatches, perJudge,
    rates: Object.fromEntries(Object.entries(perJudge).map(([judge, c]) => [judge, {
      autoPassCoverage: rate(c.autoPasses, c.binaryLabels), autoPassError: rate(c.wrongAutoPasses, c.autoPasses),
      falsePassRate: rate(c.falsePasses, Object.entries(c.confusion).filter(([k]) => k.startsWith("fail->")).reduce((sum, [, n]) => sum + n, 0)),
      falseFailureRate: rate(c.falseFailures, Object.entries(c.confusion).filter(([k]) => k.startsWith("pass->")).reduce((sum, [, n]) => sum + n, 0)),
    }])),
    latencyMs: { p50: percentile(0.5), p95: percentile(0.95) },
    usage: run.cases.reduce((sum, c) => Object.fromEntries(Object.keys(sum).map(k => [k, sum[k as keyof typeof sum] + c.usage[k as keyof typeof c.usage]])) as typeof sum,
      { jevRequests: 0, llmCalls: 0, jevInputTokens: 0, jevOutputTokens: 0, llmInputTokens: 0, llmOutputTokens: 0 }),
    versions: [...versions].map(v => JSON.parse(v)),
  };
}
