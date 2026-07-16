# Variable Extraction Judge Precision Design

**Date:** 2026-07-16  
**Target:** `dev` only  
**Scope:** Variable Extraction judge prompt, judge-specific input shaping, narrow precision guards, and regression validation

## Problem

Round 4 produced 65 Variable Extraction false-positive candidates and one false negative. Three of the false-positive candidates were ground-truth errors where AO correctly detected a missing extraction, leaving 62 genuine overfires. The production input path contained the required data: node prompts, transcripts, variable rules, configured tool mappings, actual extracted values, conversation history, and global context all reached the judge. However, variable rules appeared only in the earlier system prompt while very long, instruction-shaped node prompts followed in the user payload. Live replay showed the model replacing explicit variable rules with assumptions from those later workflow instructions. The problem is therefore both an inconsistent rubric and poor attention placement for the decisive inputs.

The current prompt uses three omission thresholds: a value merely "available in the context," a value "the user provided," and a value the user "clearly STATED." The broadest threshold encourages the judge to demand inferred values, duplicate sibling fields, unopened-gate defaults, backend identifiers, and lookup-derived values.

## Decision

Use an applicability-first rubric and repeat the exact per-variable rules plus a compact decision contract after the long call payload. When the main judge proposes a defect, use a compact focused review to verify the proposal against only the rule and transcript. Stored-value violations of an explicit-speech rule bypass that leniency review so vague speech can never be promoted into a precise bucket; proposed omissions still receive precision review.

Two narrow focused safeguards are allowed because live replay demonstrated that the model could state the correct rule and still violate it:

- A structured final-batch cutoff signal is true only when the configured recording step is before transfer/end, the transfer/end turn is marked interrupted, the caller replies, and no later agent/tool turn exists. A missing candidate is cleared only when the schedule explicitly batches all lead data and the candidate's own rule does not require immediate/earlier recording; other candidates continue to focused review.
- Config-default disagreements receive a focused contradiction review so an explicit wrong-person/dispute exception is preserved. No other defect can be added by a review.

Only one PR will be opened, targeting `dev`. Nothing will be opened against `main` or another production branch.

## Authoritative Evaluation Contract

The prompt will use one consistent contract in its introduction, numbered criteria, incorrect-value test, ambiguity guidance, and JSON-output instruction.

### Missing variables

A caller-capture variable is missing only when the caller explicitly stated its applicable value in that variable's own terms during the evaluated node and the agent had a recording opportunity but did not store it. The expected-variable list is a configured surface, not an unconditional checklist.

The following are never missing extractions:

- Values inferred, implied, computed, bucketed, classified, or summarized from caller speech.
- A fact already stored under another expected sibling or synonymous variable.
- Absent rule-produced defaults, summaries, statuses, dispositions, classifications, internal scores, and other workflow bookkeeping. If one is stored, its value is interpreted through its exact rule; its absence is not lost caller information.
- Negative, empty, default, or not-applicable values for a topic that never arose.
- Variables belonging to an unreached flow step or a gate whose condition never occurred.
- Runtime/global/initial values, backend identifiers, or values supplied by platform actions, tools, or lookup results. Their presence in context does not turn them into caller-provided values.
- Agent-authored summaries, remarks, dispositions, statuses, language labels, classifications, or internal scores.

Backend IDs and tool/lookup-result values are not caller extractions and must never be demanded merely because the judge can see them.

### Incorrect variables

An extracted value is incorrect only when it is malformed, semantically different from the supported value, contradicts the caller, or asserts unsupported facts, and the configuration does not direct that value.

Defaults, active-branch payloads, mappings, normalizations, and context sourcing explicitly directed by the variable rule are valid even when their literal representation was not spoken. The variable's rule is authoritative for extraction semantics; node instructions determine path and opportunity but cannot invent a new prerequisite. Agent-authored summaries, labels, dispositions, and workflow classifications are outside this judge and belong to Instruction Adherence or Hallucination.

### Approximation and truncation

Approximation covers normalization, reformatting, and paraphrase of information the caller actually expressed. It does not permit converting vague language into a precise bucket or threshold that the caller never stated.

An omission may be excused when structured turn order proves the transcript ended before a configured final recording batch could execute. A completed call that stored nothing receives no such exception.

## Code Changes

- Rewrite the Variable Extraction rubric in `src/evals-engine/judges/instructions.ts` so every occurrence of the decision boundary uses the authoritative contract.
- Update `OUT_VARIABLE` to match the same explicit-statement and incorrect-value rules.
- Render high-confidence judge classification hints beside variable rules and repeat the exact rules plus compact decision contract at the end of the variable judge's user payload. The exact rule remains authoritative when a free-form rule cannot be classified confidently.
- Add focused config-default and proposed-defect reviews. These reviews may only confirm or remove defects proposed by the main judge; they cannot add new ones. Preserve stored explicit-speech violations without a leniency review while still reviewing proposed omissions.
- Add the narrowly structured, candidate-specific final-batch cutoff guard described above and pass its schedule evidence to the main and focused-review payloads.
- Add calibration assertions in `tests/evals-engine-judge-calibration.test.ts` for every Round 4 root-cause carve-out and for the load-bearing strictness rules.
- Expand `scripts/overfire-smoke.ts` with anonymized Variable Extraction cases covering clean derived/sibling/gated/config-directed/agent-authored/backend/truncated inputs and defective explicit-omission/invented-classification inputs.
- Do not commit Round 4 customer transcripts or other audit data.

## Validation

Validation proceeds in four layers:

1. Run the focused judge and calibration tests.
2. Run the expanded live-model smoke harness repeatedly to check both overfire and miss boundaries.
3. Replay the locally available Round 4 Variable Extraction audit without committing its source data. Correct the three known ground-truth errors before scoring. Verify that corrected real defects and the prior false negative remain failures while clean cases no longer overfire. Investigate every remaining delta rather than hiding it in aggregate metrics.
4. Run an available earlier-round or separate holdout set to detect Round 4 overfitting, then run the complete repository test suite.

The PR body will report commands, model/provider used for live validation, confusion matrices, remaining errors if any, and the fact that lookup/backend values are intentionally out of scope for missing extraction.

## Safety and Non-goals

- No shared input-plumbing, public result schema, aggregation, database, or UI changes.
- No broad deterministic verdict rewriting. The only deterministic removal is the candidate-specific final-batch guard above; focused reviews can only remove unconfirmed proposed defects and cannot add defects.
- No Hallucination judge changes in this PR.
- No customer audit data committed to the repository.
- No PR targeting `main` or production.

If live provider credentials or the required audit artifacts are unavailable, implementation tests may continue, but the PR will not claim live Round 4 validation; the limitation will be reported before opening the PR.
