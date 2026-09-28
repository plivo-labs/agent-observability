/** Full-pipeline validation. --live explicitly enables paid model calls;
 * --results only scores an existing run and never contacts a provider. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);
const help = `Usage:
  bun scripts/eval-validation.ts --dataset calls.json --results run.json --out NEW_DIRECTORY
  bun scripts/eval-validation.ts --dataset calls.json --live --backend jev|llm --out NEW_DIRECTORY

--live sends the supplied calls to the configured providers and incurs model costs.
Use fresh, independently reviewed validation labels. Reports do not certify accuracy.
See docs/evals-validation.md for dataset schema and baseline/candidate comparison.`;

async function main() {
  if (args.includes("--help") || !args.length) { console.log(help); return; }
  const allowed = new Set(["--dataset", "--results", "--out", "--backend", "--live"]);
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

  // Standalone tool: no database or prompt registry is needed. Provider settings
  // still come from normal environment parsing and are recorded below.
  process.env.SIM_PERSIST = "false";
  process.env.JUDGES_FROM_DB = "off";
  const { DatasetSchema, RunSchema, runValidation, summarizeValidation } = await import("./lib/eval-validation.js");
  const dataset = DatasetSchema.parse(JSON.parse(await readFile(datasetPath, "utf8")));
  // An existing result directory is never overwritten, including before paid calls.
  await mkdir(out);
  await writeFile(path.join(out, "dataset.json"), JSON.stringify(dataset, null, 2));
  let run;
  if (resultsPath) {
    run = RunSchema.parse(JSON.parse(await readFile(resultsPath, "utf8")));
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
    run = await runValidation(dataset, { jev, llm, revision: revision + (dirty ? "+dirty" : ""), settings: {
      backend, llmProvider: config.LLM_PROVIDER, judgeModel: config.JUDGE_MODEL, judgeFallbackModel: config.JUDGE_MODEL_FALLBACK,
      reasoningEffort: config.JUDGE_REASONING_EFFORT, jevModel: config.JEV_MODEL,
      jevJudges: config.JEV_JUDGES, customCandidates: config.JEV_CUSTOM_METRICS,
      gateOverrides: config.JEV_GATES, stateBudget: config.JEV_STATE_TOKEN_BUDGET,
      prompts: "shipped-code", judgeConcurrency: config.EVAL_MAX_CONCURRENT_JUDGE_CALLS,
      maxJudgedNodes: config.EVAL_MAX_JUDGED_NODES, maxCustomJudgeCalls: config.EVAL_MAX_CUSTOM_JUDGE_CALLS,
      llmTimeoutMs: config.LLM_TIMEOUT_MS, llmMaxRetries: config.LLM_MAX_RETRIES,
      jevTimeoutMs: config.JEV_TIMEOUT_MS, jevConcurrency: config.JEV_MAX_CONCURRENT,
      openaiApiMode: config.OPENAI_API_MODE,
    } });
  }
  await writeFile(path.join(out, "run.json"), JSON.stringify(run, null, 2));
  const report = summarizeValidation(dataset, run);
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Wrote ${out}: ${report.sessions} sessions, ${report.failedSessions.length} errors, ${report.mismatches.length} labelled disagreements, ${report.unlabelledRows} unlabelled rows.`);
  if (report.failedSessions.length) process.exitCode = 1;
}

await main().catch(error => { console.error(String(error)); process.exitCode = 1; });
