# Variable Extraction Judge Precision Design

**Date:** 2026-07-16  
**Target:** `dev` only  
**Scope:** Variable Extraction judge prompt and its regression validation

## Problem

Round 4 produced 65 Variable Extraction false-positive candidates and one false negative. Three of the false-positive candidates were ground-truth errors where AO correctly detected a missing extraction, leaving 62 genuine overfires. The production input path was complete: node prompts, transcripts, variable rules, configured tool mappings, actual extracted values, conversation history, and global context all reached the judge. The dominant problem is therefore the rubric's inconsistent decision boundary.

The current prompt uses three omission thresholds: a value merely "available in the context," a value "the user provided," and a value the user "clearly STATED." The broadest threshold encourages the judge to demand inferred values, duplicate sibling fields, unopened-gate defaults, backend identifiers, and lookup-derived values.

## Decision

Use a prompt-only behavior change, backed by deterministic prompt tests, live-model smoke cases, an exact Round 4 replay, and holdout validation. Do not add deterministic pre- or post-processing logic in this change.

Only one PR will be opened, targeting `dev`. Nothing will be opened against `main` or another production branch.

## Authoritative Evaluation Contract

The prompt will use one consistent contract in its introduction, numbered criteria, incorrect-value test, ambiguity guidance, and JSON-output instruction.

### Missing variables

A variable is missing only when the caller explicitly stated its value in that variable's own terms during the evaluated node and the agent did not store it.

The following are never missing extractions:

- Values inferred, implied, computed, bucketed, classified, or summarized from caller speech.
- A fact already stored under another expected sibling or synonymous variable.
- Negative, empty, default, or not-applicable values for a topic that never arose.
- Variables belonging to an unreached flow step or a gate whose condition never occurred.
- Runtime/global/initial values, backend identifiers, or values supplied by platform actions, tools, or lookup results. Their presence in context does not turn them into caller-provided values.
- Agent-authored summaries, remarks, dispositions, statuses, language labels, classifications, or internal scores.

Backend IDs and tool/lookup-result values are not caller extractions and must never be demanded merely because the judge can see them.

### Incorrect variables

An extracted value is incorrect only when it is malformed, semantically different from the supported value, contradicts the caller, or asserts unsupported facts, and the configuration does not direct that value.

Defaults, active-branch payloads, mappings, normalizations, and context sourcing explicitly directed by the variable rule or node instructions are valid even when their literal representation was not spoken. Agent-authored fields are judged only for unsupported factual assertions; label choice, enum mapping, formatting, and workflow-status compliance belong to Instruction Adherence.

### Approximation and truncation

Approximation covers normalization, reformatting, and paraphrase of information the caller actually expressed. It does not permit converting vague language into a precise bucket or threshold that the caller never stated.

An omission may be excused when the transcript demonstrably ends mid-turn before a configured end-of-call recording batch could execute. A completed call that stored nothing receives no such exception.

## Code Changes

- Rewrite the Variable Extraction rubric in `src/evals-engine/judges/instructions.ts` so every occurrence of the decision boundary uses the authoritative contract.
- Update `OUT_VARIABLE` to match the same explicit-statement and incorrect-value rules.
- Add calibration assertions in `tests/evals-engine-judge-calibration.test.ts` for every Round 4 root-cause carve-out and for the load-bearing strictness rules.
- Expand `scripts/overfire-smoke.ts` with anonymized Variable Extraction cases covering clean derived/sibling/gated/config-directed/agent-authored/backend/truncated inputs and defective explicit-omission/invented-classification inputs.
- Do not commit Round 4 customer transcripts or other audit data.

## Validation

Validation proceeds in four layers:

1. Run the focused judge and calibration tests.
2. Run the expanded live-model smoke harness repeatedly to check both overfire and miss boundaries.
3. Replay the locally available Round 4 Variable Extraction audit without committing its source data. Correct the three known ground-truth errors before scoring. Verify that the 28 corrected true positives remain failures, the prior false negative becomes a failure, and clean cases no longer overfire. Investigate every remaining delta rather than hiding it in aggregate metrics.
4. Run an available earlier-round or separate holdout set to detect Round 4 overfitting, then run the complete repository test suite.

The PR body will report commands, model/provider used for live validation, confusion matrices, remaining errors if any, and the fact that lookup/backend values are intentionally out of scope for missing extraction.

## Safety and Non-goals

- No input-plumbing, schema, aggregation, database, or UI changes.
- No Variable Extraction verdict post-processing.
- No Hallucination judge changes in this PR.
- No customer audit data committed to the repository.
- No PR targeting `main` or production.

If live provider credentials or the required audit artifacts are unavailable, implementation tests may continue, but the PR will not claim live Round 4 validation; the limitation will be reported before opening the PR.
