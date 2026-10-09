// Opt-in semantic tests for the real prompts, complementing mocked guard tests.
// bun --env-file=.env scripts/validate-judge-regressions.ts --live --out results.json --repeat 3
import { semanticCases } from "../tests/fixtures/judge-semantic-regressions.js";

const args = process.argv.slice(2);
if (!args.includes("--live")) {
  console.log("Usage: bun scripts/validate-judge-regressions.ts --live --out NEW_FILE [--repeat 3]\nUses the pinned JUDGE_MODEL and configured provider; incurs model costs. Fixtures contain synthetic data only.");
  process.exit(args.length ? 1 : 0);
}
const options = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--live") continue;
  if (!["--out", "--repeat"].includes(arg) || options.has(arg) || !args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(`Invalid option: ${arg}`);
  options.set(arg, args[++i]!);
}
const output = options.get("--out");
const repeats = Number(options.get("--repeat") ?? 1);
if (!output || !Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("Supply --out NEW_FILE and --repeat between 1 and 10");
if (await Bun.file(output).exists()) throw new Error(`Refusing to overwrite ${output}`);
process.env.SIM_PERSIST = "false";
process.env.DATABASE_URL = "";
process.env.JUDGES_FROM_DB = "off";
const { config } = await import("../src/config.js");
if (!config.JUDGE_MODEL || config.JUDGE_MODEL_FALLBACK) throw new Error("Pin JUDGE_MODEL and unset JUDGE_MODEL_FALLBACK");
const { runCustomMetricJudge, CUSTOM_METRIC_OUT } = await import("../src/evals-engine/judges/custom-metric.js");
const { runVariableExtractionJudge } = await import("../src/evals-engine/judges/variable-extraction.js");
const results: Array<{ id: string; trial: number; expected: string; actual: string; reason: string }> = [];
const report = { model: config.JUDGE_MODEL, provider: config.LLM_PROVIDER, startedAt: new Date().toISOString(), results };
for (let trial = 1; trial <= repeats; trial++) {
  for (const c of semanticCases) {
    let actual: string;
    let reason: string;
    try {
      if (c.kind === "custom") {
        const result = await runCustomMetricJudge({
          name: `metric:${c.id.replaceAll("-", "_")}`, display_name: c.id,
          scope: "conversation", body: c.body, output: CUSTOM_METRIC_OUT,
        }, c.input, (ref) => ref);
        actual = result.available ? result.verdict : "unavailable";
        reason = result.reason || result.technical_reason;
      } else {
        const { data } = await runVariableExtractionJudge(c.node, c.input);
        actual = data.extraction_successful ? "pass" : "fail";
        reason = data.reason;
      }
    } catch (error) {
      actual = "error";
      reason = String(error);
    }
    results.push({ id: c.id, trial, expected: c.expected, actual, reason });
    await Bun.write(output, JSON.stringify(report, null, 2) + "\n");
    console.log(`${actual === c.expected ? "PASS" : "FAIL"} ${c.id} trial=${trial}: expected=${c.expected} actual=${actual}`);
    // Bound request volume on shared deployments, including secondary reviews.
    await Bun.sleep(6000);
  }
}
const failures = results.filter(r => r.actual !== r.expected);
console.log(`${results.length - failures.length}/${results.length} matched; ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;
