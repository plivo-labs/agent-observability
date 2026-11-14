# Validate the complete eval pipeline

This tool executes the same ingest adapter, judges, aggregation, conversation priority rules, custom roll-up and final row selection used by session evaluation. It compares **final emitted rows** with independently reviewed labels. It does not score intermediate probabilities as if they were saved verdicts.

It uses the public evaluator API, so it can run against any checkout. Keep the dataset and provider settings fixed when comparing runs; the engine's active policy determines which model makes each decision.

## Dataset contract

Supply JSON with this shape (example is synthetic, not an accuracy benchmark):

```json
{
  "schemaVersion": 1,
  "datasetId": "orders-review-001",
  "labelRevision": "review-1",
  "split": "synthetic",
  "reviewer": "fixture-author",
  "cases": [{
    "id": "call-001",
    "groupId": "orders-agent-template-001",
    "config": {
      "flow_name": "orders",
      "nodes": [{"ref": "A", "name": "collect", "instructions": "Ask for the order id."}]
    },
    "events": [
      {"type": "conversation_item_added", "node_ref": "A", "item": {"type": "message", "role": "assistant", "content": "What is your order id?"}},
      {"type": "conversation_item_added", "node_ref": "A", "item": {"type": "message", "role": "user", "content": "42"}}
    ],
    "transport": "livekit",
    "expected": [
      {"judgeName": "node_loop", "tag": "A", "verdict": "pass"},
      {"judgeName": "voicemail_detection", "tag": null, "verdict": "pass"}
    ]
  }]
}
```

`tag` is the sender's node ref, or null for conversation rows. Valid labels are `pass`, `fail`, `unknown`, and `absent`. Use `absent` when the correct final behavior is no row (for example a voice-only detector on chat). Include `customJudges` with the ordinary spec fields and `tags` with ordinary session tags where needed. Labels never enter model prompts. Duplicate case IDs or judge/node labels are rejected.

For real evaluation, use `split: "validation"`, a frozen dataset ID, label revision and reviewer. Keep agent/template groups separate from calibration data, correct disputed labels, and retain supporting evidence in the review process. The tool records group counts but cannot prove independence, label correctness or statistical adequacy. Reports never automatically authorize an accuracy claim or a policy promotion.

## Run and compare

Print usage without keys or network access:

```sh
bun scripts/eval-validation.ts --help
```

Run paid models only with an explicit `--live` flag, a pinned `JUDGE_MODEL`, configured LLM credentials, and `JEV_API_KEY` for the Jev backend:

```sh
bun scripts/eval-validation.ts --dataset /secure/calls.json --live --backend jev --out /secure/candidate-run
bun scripts/eval-validation.ts --dataset /secure/calls.json --live --backend llm --out /secure/llm-reference-run
```

Run baseline and candidate checkouts against the same frozen dataset. `--backend llm` is a comparison model, **not ground truth**. Live calls use the configured judge/Jev limits and retries; cases run serially, while each case retains normal judge concurrency. A session error stops the run and marks remaining cases `not_run`, preventing unfinished sibling judges from affecting the next case. The tool is stateless and uses shipped prompts, so it does not require a database or read the deployed prompt registry. This is a limitation when production registry prompts differ.

Re-score an existing run without any model calls:

```sh
bun scripts/eval-validation.ts --dataset /secure/candidate-run/dataset.json --results /secure/candidate-run/run.json --out /secure/rescored
```

The output directory must be new. `dataset.json` snapshots the parsed inputs, `run.json` retains aggregate verdicts (including unavailable signals), final rows, observed token usage and elapsed time, and `report.json` records:

- Per-judge confusion matrices across pass/fail/unknown/absent; false passes, false failures, missing and unknown outcomes remain distinct. `outcomes` preserves every labelled case/judge/node key, expected verdict and actual verdict for paired comparisons.
- Fail precision and recall with Wilson 95% intervals (`failPrecisionInterval95` and `failRecallInterval95`). Precision divides correctly predicted failures by all predicted failures; recall divides them by all fail labels, including unknown/absent predictions. A zero denominator gives a null rate and interval. `unknownAbsentShare` divides unknown plus absent predictions by all labelled rows for that judge.
- Auto-pass coverage and error on binary-labelled rows, reviewed candidate overrides when provenance is available, and unlabelled row counts. Unlabelled outputs never become implicit successes.
- Session errors, disagreements with case/node identity, p50/p95 latency, observed tokens, model/settings/code revision and available gate/evidence/question/policy versions.

A SHA-256 fingerprint binds the run to the exact parsed dataset and labels; changed labels require a new named run. A failed case remains an error with missing rows, never a clean result. Failed cases have frozen partial usage, and failed/not-run cases are excluded from completed-case token totals and latency percentiles. Outstanding providers are asked to abort; returned partial counts can omit late sibling responses and are not billing measurements. The CLI exits 1 for failed or incomplete sessions. Without `--baseline`, label disagreements are reported without a gate. Token counts cover returned provider usage; failed attempts and Jev-internal retries may have unreported billed usage. Wall time includes normal retries and concurrency, so compare repeated runs before drawing latency conclusions.

### Gate a candidate against a baseline

```sh
bun scripts/eval-validation.ts --dataset /secure/calls.json --results /secure/candidate-run/run.json --baseline /secure/baseline-run/report.json --out /secure/compared
```

The baseline's dataset fingerprint and label revision must match; otherwise the CLI refuses it with exit 2 before judging. Reports must contain exactly the same unique case/judge/node keys and expected labels. Missing, duplicate or changed keys/labels also cause exit 2. Older reports without `outcomes` must be re-scored from their saved `run.json` using this version of the tool.

`report.json.comparison` records per-judge paired counts: `fixed` means a previously incorrect row now exactly matches its label; `broke` means a previously correct row no longer matches. Unknown and absent are distinct verdicts and are correct only when the label matches. Rows that remain incorrect do not count as fixes. The exact two-sided McNemar/sign test conditions on `fixed + broke` discordant pairs, using twice the smaller binomial tail under probability 0.5, capped at 1. With no discordant pairs, p is 1. A judge fails the gate when `broke > fixed` and `pValue < 0.05`.

Coverage is gated independently: the unknown/absent share across **all labelled rows for each judge** must not increase by more than two percentage points. This prevents an all-unknown candidate from appearing safe merely because it has no false passes or false failures. `--unknown-margin 0.03` permits three percentage points; `0` permits no increase. This flag requires `--baseline` and accepts fractions from 0 to 1. A rise exactly at the margin passes. Comparisons include paired row counts, baseline/candidate unknown-plus-absent counts, the share increase, and separate correctness/coverage regression flags.

Exit 0 means no gate failed; exit 1 means any judge regressed in correctness or coverage, or a session failed/was not run. Exit 2 means the baseline is incompatible. Improvements in one judge cannot cancel a regression in another. Passing is not evidence of equivalence or permission to promote: the test has limited power on small samples, uses no multiple-testing correction, and does not adjust for correlated rows within calls or groups.

### Measure repeat stability

```sh
bun scripts/eval-validation.ts --dataset /secure/calls.json --live --backend llm --repeat 3 --out /secure/repeated
```

`--repeat N` requires live judging and an integer of at least 2; N is the total number of runs and multiplies model usage. The first run keeps `run.json`/`report.json`; subsequent runs use `run-2.json`/`report-2.json`, and so on. Every trial uses the same inputs and settings. The first report also contains `repeat.runs` and per-judge `comparisons`, `flips` and `flipRate`: a flip is a change in actual verdict for the same labelled key between consecutive runs, including transitions to/from unknown or absent. Unlabelled outputs are excluded. With N completed trials, each labelled row contributes N−1 comparisons.

If supplied, the baseline gates every trial; a regression in any trial exits 1. A failed/incomplete session stops further trials, and saved artifacts retain the results so far. A repeat summary is available once at least two trials have been recorded. Flip rate describes stability, not accuracy, and has no additional exit threshold.

Run artifacts contain transcripts, configuration and detailed verdicts. Keep them in the same protected location as the source call dataset; do not commit real calls or credentials.

## Acceptance tests

`bun test tests/eval-validation.test.ts` uses injected mock providers to run the real evaluator through fan-out. It checks scope mapping, mismatches, missing outputs, label fingerprints and duplicate rejection, plus Wilson intervals, exact paired gate decisions, per-judge coverage margins, incompatible baselines, and live repeat output with a mocked provider. Those synthetic tests prove tooling behavior, not model accuracy. Real held-out accuracy testing is a separate step requiring the reviewed call dataset.

For the custom-metric applicability and variable-review regressions, run the real judge prompts against the synthetic cases in `tests/fixtures/judge-semantic-regressions.ts`:

```sh
JUDGE_MODEL=<deployment> JUDGE_MODEL_FALLBACK='' bun --env-file=.env scripts/validate-judge-regressions.ts --live --out /tmp/judge-regressions.json --repeat 3
```

The output file must be new. The runner disables database persistence and prompt-registry loading, records each trial, and exits nonzero for a mismatch or unavailable result. It covers unreached and reached metric situations, explicit early-termination failures, interrupted closings, unsupported qualification, and valid configured defaults. Labels are not sent to the model. Repeat against the production model before claiming model parity; this focused suite does not measure production-wide accuracy.
