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
    id: z.string(), status: z.enum(["completed", "failed", "not_run"]), durationMs: z.number(), usage: UsageSchema, rows: z.array(RowSchema),
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
  for (const [caseIndex, c] of dataset.cases.entries()) {
    const caseAbort = new AbortController();
    const usage = { jevRequests: 0, llmCalls: 0, jevInputTokens: 0, jevOutputTokens: 0, llmInputTokens: 0, llmOutputTokens: 0 };
    const llm: LlmProvider = { name: opts.llm.name, async complete(args) {
      if (caseAbort.signal.aborted) throw new Error("Validation case stopped");
      usage.llmCalls++;
      const result = await opts.llm.complete({ ...args, signal: AbortSignal.any([args.signal, caseAbort.signal]) });
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
      cases.push({ id: c.id, status: "completed", durationMs: performance.now() - start, usage: { ...usage }, rows: buildExternalEvalRows(aggregate), aggregate });
    } catch (error) {
      // Promise.all rejects before sibling judges settle: stop the dataset so later
      // cases cannot overlap those calls, and snapshot usage so they cannot mutate it.
      caseAbort.abort();
      cases.push({ id: c.id, status: "failed", durationMs: performance.now() - start, usage: { ...usage }, rows: [], error: String(error) });
      for (const pending of dataset.cases.slice(caseIndex + 1)) cases.push({
        id: pending.id, status: "not_run", durationMs: 0, rows: [], error: `Not run after failed case ${c.id}`,
        usage: { jevRequests: 0, llmCalls: 0, jevInputTokens: 0, jevOutputTokens: 0, llmInputTokens: 0, llmOutputTokens: 0 },
      });
      break;
    }
  }
  return { schemaVersion: 1, datasetFingerprint: fingerprint(dataset), revision: opts.revision, settings: opts.settings, startedAt, cases };
}

function verdictOf(row: ExternalEvalRow | undefined): Verdict {
  return !row ? "absent" : row.verdictText === "unknown" ? "unknown" : row.passed ? "pass" : "fail";
}
const OutcomeSchema = LabelSchema.extend({ caseId: z.string(), expected: VerdictSchema, actual: VerdictSchema }).omit({ verdict: true });
type Outcome = z.infer<typeof OutcomeSchema>;

const newCounts = () => ({ labelled: 0, binaryLabels: 0, matches: 0, falsePasses: 0, falseFailures: 0, unknown: 0, missing: 0, autoPasses: 0, wrongAutoPasses: 0, reviewedCandidates: 0, candidateOverrides: 0, confusion: {} as Record<string, number> });
const rate = (n: number, d: number) => d ? n / d : null;

function wilson95(successes: number, total: number) {
  if (!total) return null;
  const z = 1.959963984540054;
  const estimate = successes / total;
  const scale = 1 + z * z / total;
  const center = (estimate + z * z / (2 * total)) / scale;
  const radius = z * Math.sqrt(estimate * (1 - estimate) / total + z * z / (4 * total * total)) / scale;
  return { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) };
}

/** Score FINAL emitted rows, preserving absent/unknown and unlabelled outputs.
 * Labels never enter model prompts. A fingerprint mismatch requires a fresh run. */
export function summarizeValidation(dataset: ValidationDataset, run: ValidationRun) {
  if (run.datasetFingerprint !== fingerprint(dataset)) throw new Error("Run dataset fingerprint does not match inputs/label revision");
  if (run.cases.length !== dataset.cases.length || new Set(run.cases.map(c => c.id)).size !== run.cases.length ||
      run.cases.some(c => !dataset.cases.some(d => d.id === c.id))) throw new Error("Run must contain exactly one result for each dataset case");
  const results = new Map(run.cases.map(c => [c.id, c]));
  const perJudge: Record<string, ReturnType<typeof newCounts>> = {};
  const outcomes: Outcome[] = [];
  const mismatches: Outcome[] = [];
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
      if (j) versions.add(JSON.stringify({ model: row.raw.jev_model, evidence: j.evidence_version, questions: j.question_version, policy: j.policy_version, gate: j.gate, layout: j.layout, judge: row.judgeName }));
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
      const outcome = { caseId: c.id, judgeName: label.judgeName, tag: label.tag, expected: label.verdict, actual };
      outcomes.push(outcome);
      if (actual === label.verdict) counts.matches++;
      else mismatches.push(outcome);
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
  const completed = run.cases.filter(c => c.status === "completed" && !c.error);
  const times = completed.map(c => c.durationMs).sort((a, b) => a - b);
  const percentile = (p: number) => times[Math.max(0, Math.ceil(times.length * p) - 1)] ?? null;
  return {
    datasetId: dataset.datasetId, labelRevision: dataset.labelRevision, split: dataset.split, reviewer: dataset.reviewer,
    datasetFingerprint: run.datasetFingerprint, revision: run.revision, settings: run.settings,
    // Metadata cannot prove label independence or statistical adequacy.
    accuracyClaimAllowed: false,
    validationNote: "Inspect independent label quality, held-out groups and per-judge sample sizes before making accuracy claims.",
    sessions: run.cases.length, groups: new Set(dataset.cases.map(c => c.groupId)).size,
    failedSessions: run.cases.filter(c => c.status === "failed").map(c => c.id),
    notRunSessions: run.cases.filter(c => c.status === "not_run").map(c => c.id), unlabelledRows, mismatches, outcomes, perJudge,
    rates: Object.fromEntries(Object.entries(perJudge).map(([judge, c]) => {
      const trueFails = c.confusion["fail->fail"] ?? 0;
      const predictedFails = Object.entries(c.confusion).filter(([k]) => k.endsWith("->fail")).reduce((sum, [, n]) => sum + n, 0);
      const labelledFails = Object.entries(c.confusion).filter(([k]) => k.startsWith("fail->")).reduce((sum, [, n]) => sum + n, 0);
      return [judge, {
        failPrecision: rate(trueFails, predictedFails), failRecall: rate(trueFails, labelledFails),
        failPrecisionInterval95: wilson95(trueFails, predictedFails), failRecallInterval95: wilson95(trueFails, labelledFails),
        unknownAbsentShare: rate(c.unknown + c.missing, c.labelled),
        autoPassCoverage: rate(c.autoPasses, c.binaryLabels), autoPassError: rate(c.wrongAutoPasses, c.autoPasses),
        falsePassRate: rate(c.falsePasses, Object.entries(c.confusion).filter(([k]) => k.startsWith("fail->")).reduce((sum, [, n]) => sum + n, 0)),
        falseFailureRate: rate(c.falseFailures, Object.entries(c.confusion).filter(([k]) => k.startsWith("pass->")).reduce((sum, [, n]) => sum + n, 0)),
      }];
    })),
    latencyMs: { samples: completed.length, p50: percentile(0.5), p95: percentile(0.95) },
    partialUsage: run.cases.filter(c => c.status === "failed").map(c => ({ caseId: c.id, observedAtFailure: c.usage, complete: false })),
    usage: completed.reduce((sum, c) => Object.fromEntries(Object.keys(sum).map(k => [k, sum[k as keyof typeof sum] + c.usage[k as keyof typeof c.usage]])) as typeof sum,
      { jevRequests: 0, llmCalls: 0, jevInputTokens: 0, jevOutputTokens: 0, llmInputTokens: 0, llmOutputTokens: 0 }),
    versions: [...versions].map(v => JSON.parse(v)),
  };
}

const ComparisonReportSchema = z.object({
  datasetFingerprint: z.string(), labelRevision: z.string(), outcomes: z.array(OutcomeSchema).min(1),
});
type ComparisonReport = z.infer<typeof ComparisonReportSchema>;

/** Checked before any judging: a live run is paid for, so an unusable baseline must fail first. */
export function parseBaseline(saved: unknown, dataset: ValidationDataset): ComparisonReport {
  const parsed = ComparisonReportSchema.safeParse(saved);
  if (!parsed.success) throw new Error(`Baseline is not a comparable report (needs datasetFingerprint, labelRevision and outcomes): ${parsed.error.issues.map(i => i.path.join(".") || "root").join(", ")}`);
  if (parsed.data.datasetFingerprint !== fingerprint(dataset)) throw new Error("Baseline dataset fingerprint differs");
  if (parsed.data.labelRevision !== dataset.labelRevision) throw new Error("Baseline label revision differs");
  return parsed.data;
}
const outcomeKey = (row: Outcome) => JSON.stringify([row.caseId, row.judgeName, row.tag]);

function pairedOutcomes(baseline: unknown, candidate: unknown): Array<[Outcome, Outcome]> {
  const before = ComparisonReportSchema.parse(baseline), after = ComparisonReportSchema.parse(candidate);
  if (before.datasetFingerprint !== after.datasetFingerprint) throw new Error("Baseline dataset fingerprint differs");
  if (before.labelRevision !== after.labelRevision) throw new Error("Baseline label revision differs");
  const index = (report: ComparisonReport) => {
    const rows = new Map(report.outcomes.map(row => [outcomeKey(row), row]));
    if (rows.size !== report.outcomes.length) throw new Error("Duplicate case/judge/node outcome");
    return rows;
  };
  const rows = index(before);
  if (rows.size !== index(after).size) throw new Error("Reports must have the same case/judge/node keys");
  return after.outcomes.map(row => {
    const previous = rows.get(outcomeKey(row));
    if (!previous || previous.expected !== row.expected) throw new Error("Reports must have the same case/judge/node keys and labels");
    return [previous, row];
  });
}

function discordantPValue(fixed: number, broke: number) {
  const n = fixed + broke, k = Math.min(fixed, broke);
  if (fixed === broke) return 1;
  // Log probabilities avoid underflow before the tail is summed on large datasets.
  let logProbability = -n * Math.log(2);
  for (let i = 1; i <= k; i++) logProbability += Math.log((n - i + 1) / i);
  let tail = 1, term = 1;
  for (let i = k; i > 0; i--) {
    term *= i / (n - i + 1);
    tail += term;
  }
  return Math.min(1, 2 * Math.exp(logProbability) * tail);
}

export function compareValidation(baseline: unknown, candidate: unknown, unknownMargin = 0.02) {
  if (!Number.isFinite(unknownMargin) || unknownMargin < 0 || unknownMargin > 1) throw new Error("Unknown margin must be between 0 and 1");
  const perJudge: Record<string, {
    paired: number; fixed: number; broke: number; pValue: number; regression: boolean;
    baselineUnknownAbsent: number; candidateUnknownAbsent: number; unknownAbsentIncrease: number; coverageRegression: boolean;
  }> = Object.create(null);
  let pairs: Array<[Outcome, Outcome]>;
  try { pairs = pairedOutcomes(baseline, candidate); }
  catch (error) { return { exitCode: 2 as const, error: String(error), perJudge }; }
  for (const [before, after] of pairs) {
    const counts = perJudge[after.judgeName] ??= {
      paired: 0, fixed: 0, broke: 0, pValue: 1, regression: false,
      baselineUnknownAbsent: 0, candidateUnknownAbsent: 0, unknownAbsentIncrease: 0, coverageRegression: false,
    };
    counts.paired++;
    if (before.actual === "unknown" || before.actual === "absent") counts.baselineUnknownAbsent++;
    if (after.actual === "unknown" || after.actual === "absent") counts.candidateUnknownAbsent++;
    const wasCorrect = before.actual === before.expected, isCorrect = after.actual === after.expected;
    if (!wasCorrect && isCorrect) counts.fixed++;
    if (wasCorrect && !isCorrect) counts.broke++;
  }
  for (const counts of Object.values(perJudge)) {
    counts.pValue = discordantPValue(counts.fixed, counts.broke);
    counts.regression = counts.broke > counts.fixed && counts.pValue < 0.05;
    const increase = counts.candidateUnknownAbsent - counts.baselineUnknownAbsent;
    counts.unknownAbsentIncrease = increase / counts.paired;
    counts.coverageRegression = increase > unknownMargin * counts.paired;
  }
  return { exitCode: Object.values(perJudge).some(c => c.regression || c.coverageRegression) ? 1 as const : 0 as const, perJudge };
}

export function summarizeRepeats(reports: unknown[]) {
  if (reports.length < 2) throw new Error("Repeat summary requires at least two runs");
  const perJudge: Record<string, { comparisons: number; flips: number; flipRate: number }> = Object.create(null);
  for (let i = 1; i < reports.length; i++) {
    for (const [before, after] of pairedOutcomes(reports[i - 1], reports[i])) {
      const counts = perJudge[after.judgeName] ??= { comparisons: 0, flips: 0, flipRate: 0 };
      counts.comparisons++;
      if (before.actual !== after.actual) counts.flips++;
    }
  }
  for (const counts of Object.values(perJudge)) counts.flipRate = counts.flips / counts.comparisons;
  return { runs: reports.length, perJudge };
}
