/** Full-pipeline validation. --live explicitly enables paid model calls;
 * --results only scores an existing run and never contacts a provider. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ValidationRun } from "./lib/eval-validation.js";

const args = process.argv.slice(2);
const help = `Usage:
  bun scripts/eval-validation.ts --dataset calls.json --results run.json --out NEW_DIRECTORY [--baseline report.json]
  bun scripts/eval-validation.ts --dataset calls.json --live --backend jev|llm --out NEW_DIRECTORY [--repeat N] [--baseline report.json]

--baseline gates paired regressions and unknown/absent coverage per judge.
--unknown-margin sets the allowed coverage loss as a fraction (default 0.02).
--repeat N requires --live and at least two total judging runs; reports adjacent verdict flips.
Exit codes: 0 accepted, 1 regression or run/argument error, 2 incompatible baseline.

--live sends the supplied calls to the configured providers and incurs model costs.
Use fresh, independently reviewed validation labels. Reports do not certify accuracy.
See docs/evals-validation.md for dataset schema and baseline/candidate comparison.`;

async function main() {
  if (args.includes("--help") || !args.length) { console.log(help); return; }
  const allowed = new Set(["--dataset", "--results", "--out", "--backend", "--live", "--baseline", "--unknown-margin", "--repeat"]);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!allowed.has(flag) || values.has(flag)) throw new Error(`Unknown or duplicate option: ${flag}`);
    if (flag === "--live") { values.set(flag, "true"); continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    values.set(flag, value);
  }
  const datasetPath = values.get("--dataset"), out = values.get("--out"), resultsPath = values.get("--results");
  const live = values.has("--live"), backend = values.get("--backend");
  if (!datasetPath || !out || live === !!resultsPath || (live && backend !== "jev" && backend !== "llm") || (!live && backend)) throw new Error(help);

  const unknownMargin = Number(values.get("--unknown-margin") ?? 0.02);
  if (!Number.isFinite(unknownMargin) || unknownMargin < 0 || unknownMargin > 1) throw new Error("--unknown-margin must be between 0 and 1 (0.02 = two percentage points)");
  if (values.has("--unknown-margin") && !values.has("--baseline")) throw new Error("--unknown-margin requires --baseline");

  if (values.has("--repeat") && !live) throw new Error("--repeat requires --live");
  const repeat = Number(values.get("--repeat") ?? 1);
  if (!Number.isSafeInteger(repeat) || repeat < (values.has("--repeat") ? 2 : 1)) throw new Error("--repeat must be an integer of at least 2");

  // Standalone: needs no database or prompt registry.
  process.env.SIM_PERSIST = "false";
  process.env.JUDGES_FROM_DB = "off";
  const { DatasetSchema, RunSchema, runValidation, summarizeValidation, compareValidation, summarizeRepeats, parseBaseline } = await import("./lib/eval-validation.js");
  const dataset = DatasetSchema.parse(JSON.parse(await readFile(datasetPath, "utf8")));
  let baseline: unknown;
  if (values.has("--baseline")) {
    try {
      baseline = parseBaseline(JSON.parse(await readFile(values.get("--baseline")!, "utf8")), dataset);
    } catch (error) { console.error(String(error)); process.exitCode = 2; return; }
  }
  // An existing result directory is never overwritten, including before paid calls.
  await mkdir(out);
  await writeFile(path.join(out, "dataset.json"), JSON.stringify(dataset, null, 2));
  let judge: () => Promise<ValidationRun>;
  if (resultsPath) {
    const run = RunSchema.parse(JSON.parse(await readFile(resultsPath, "utf8")));
    judge = async () => run;
  } else {
    const { config } = await import("../src/config.js");
    if (backend === "jev" && !config.JEV_API_KEY) throw new Error("JEV_API_KEY is required for --backend jev");
    if (config.LLM_PROVIDER === "openai" ? !config.OPENAI_API_KEY : !config.ANTHROPIC_API_KEY) throw new Error("The configured LLM provider needs an API key");
    if (!config.JUDGE_MODEL) throw new Error("Pin JUDGE_MODEL for reproducible validation");
    const llm = config.LLM_PROVIDER === "openai"
      ? (await import("../src/llm/providers/openai.js")).openaiProvider
      : (await import("../src/llm/providers/anthropic.js")).anthropicProvider;
    const { HttpJevClient } = await import("../src/jev/client.js");
    const jev = backend === "jev" ? new HttpJevClient({
      apiKey: config.JEV_API_KEY!, model: config.JEV_MODEL, baseUrl: config.JEV_BASE_URL,
      timeoutMs: config.JEV_TIMEOUT_MS, maxConcurrent: config.JEV_MAX_CONCURRENT,
    }) : undefined;
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = !!execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
    console.log(`Evaluating ${dataset.cases.length} cases using ${backend}; split=${dataset.split}`);
    judge = () => runValidation(dataset, { jev, llm, revision: revision + (dirty ? "+dirty" : ""), settings: {
      backend, llmProvider: config.LLM_PROVIDER, judgeModel: config.JUDGE_MODEL, judgeFallbackModel: config.JUDGE_MODEL_FALLBACK,
      reasoningEffort: config.JUDGE_REASONING_EFFORT, jevModel: config.JEV_MODEL,
      jevJudges: config.JEV_JUDGES, customCandidates: config.JEV_CUSTOM_METRICS,
      gateOverrides: config.JEV_GATES, stateBudget: config.JEV_STATE_TOKEN_BUDGET,
      jevLayout: config.JEV_LAYOUT, nodeAutoPass: config.JEV_NODE_AUTO_PASS, autoFail: config.JEV_AUTO_FAIL,
      decisionReasons: config.JEV_DECISION_REASONS,
      prompts: "shipped-code", judgeConcurrency: config.EVAL_MAX_CONCURRENT_JUDGE_CALLS,
      maxJudgedNodes: config.EVAL_MAX_JUDGED_NODES, maxCustomJudgeCalls: config.EVAL_MAX_CUSTOM_JUDGE_CALLS,
      llmTimeoutMs: config.LLM_TIMEOUT_MS, llmMaxRetries: config.LLM_MAX_RETRIES,
      jevTimeoutMs: config.JEV_TIMEOUT_MS, jevConcurrency: config.JEV_MAX_CONCURRENT,
      openaiApiMode: config.OPENAI_API_MODE,
    } });
  }
  const reports: Array<ReturnType<typeof summarizeValidation> & { comparison?: ReturnType<typeof compareValidation> }> = [];
  let exitCode = 0;
  for (let trial = 1; trial <= repeat; trial++) {
    const run = await judge();
    const suffix = trial === 1 ? "" : `-${trial}`;
    await writeFile(path.join(out, `run${suffix}.json`), JSON.stringify(run, null, 2));
    const summary = summarizeValidation(dataset, run);
    const comparison = baseline === undefined ? undefined : compareValidation(baseline, summary, unknownMargin);
    const report = { ...summary, comparison };
    reports.push(report);
    await writeFile(path.join(out, `report${suffix}.json`), JSON.stringify(report, null, 2));
    console.log(`Wrote ${out}/report${suffix}.json: ${report.sessions} sessions, ${report.failedSessions.length} errors, ${report.mismatches.length} labelled disagreements, ${report.unlabelledRows} unlabelled rows.`);
    if (comparison?.error) console.error(comparison.error);
    const incomplete = run.cases.some(c => c.status !== "completed" || c.error);
    exitCode = Math.max(exitCode, comparison?.exitCode ?? 0, incomplete ? 1 : 0);
    if (incomplete || comparison?.exitCode === 2) break;
  }
  if (reports.length > 1) {
    await writeFile(path.join(out, "report.json"), JSON.stringify({ ...reports[0], repeat: summarizeRepeats(reports) }, null, 2));
  }
  process.exitCode = exitCode;
}

await main().catch(error => { console.error(String(error)); process.exitCode = 1; });
