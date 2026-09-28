# Validate the complete eval pipeline

This tool executes the same ingest adapter, judges, aggregation, conversation priority rules, custom roll-up and final row selection used by session evaluation. It compares **final emitted rows** with independently reviewed labels. It does not score intermediate probabilities as if they were saved verdicts.

The tooling PR is independent of the evidence-first engine PR: it uses the existing evaluator API and can run against either version. Copy/cherry-pick this tooling onto each comparison checkout, keeping the same dataset and provider settings. The engine's active policy determines which model makes each decision.

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

Run baseline and candidate checkouts against the same frozen dataset. `--backend llm` is a comparison model, **not ground truth**. Live calls use the configured judge/JeV limits and retries; cases run serially, while each case retains normal judge concurrency. The tool is stateless and uses shipped prompts, so it does not require a database or read the deployed prompt registry. This is a limitation when production registry prompts differ.

Re-score an existing run without any model calls:

```sh
bun scripts/eval-validation.ts --dataset /secure/candidate-run/dataset.json --results /secure/candidate-run/run.json --out /secure/rescored
```

The output directory must be new. `dataset.json` snapshots the parsed inputs, `run.json` retains aggregate verdicts (including unavailable signals), final rows, observed token usage and elapsed time, and `report.json` records:

- Per-judge confusion matrices across pass/fail/unknown/absent; false passes, false failures, missing and unknown outcomes remain distinct.
- Auto-pass coverage and error on binary-labelled rows, reviewed candidate overrides when provenance is available, and unlabelled row counts. Unlabelled outputs never become implicit successes.
- Session errors, disagreements with case/node identity, p50/p95 latency, observed tokens, model/settings/code revision and available gate/evidence/question/policy versions.

A SHA-256 fingerprint binds the run to the exact parsed dataset and labels; changed labels require a new named run. A failed case remains an error with missing rows, never a clean result. The CLI exits nonzero for session errors. Disagreements are reported without an automatic promotion threshold. Token counts cover returned provider usage; failed attempts and Jev-internal retries may have unreported billed usage. Wall time includes normal retries and concurrency, so compare repeated runs before drawing latency conclusions.

Run artifacts contain transcripts, configuration and detailed verdicts. Keep them in the same protected location as the source call dataset; do not commit real calls or credentials.

## Acceptance tests

`bun test tests/eval-validation.test.ts` uses injected mock providers to run the real evaluator through fan-out. It checks scope mapping, mismatches, missing outputs, label fingerprints and duplicate rejection. Those synthetic tests prove tooling behavior, not model accuracy. Real held-out accuracy testing is a separate step requiring the reviewed call dataset.
