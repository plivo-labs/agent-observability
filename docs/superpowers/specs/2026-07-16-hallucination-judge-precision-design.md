# Hallucination Judge Precision Hardening

## Outcome

Reduce the hallucination judge's Round 4 false positives without suppressing its confirmed true positives or introducing new failures in other judges. PR #105 remains the single hallucination PR and targets `dev` only. PR #106 remains a separate low-engagement change.

## Evidence and problem statement

Round 4 contains 315 production calls. The AO hallucination judge raised 38 flags: 4 true positives and 34 false positives. The audited false-positive clusters are:

- About 18 calls where synthetic `Tool_Call`, `Tool_Result`, `System_Note`, or `Agent_Handoff` evidence was rendered with an `Agent:` prefix and could be mistaken for caller-facing speech.
- About 10 calls where the claimed fact was present in node instructions, global variables, tool output, knowledge-base context, or another valid payload field but the judge failed to credit it.
- Three calls where instruction, variable-extraction, or timing/permittedness concerns were incorrectly charged as hallucination.
- Two calls where a non-falsifiable imperative, reassurance, or process statement was treated as a fabricated fact.
- One call where an unrendered placeholder was interpreted literally.

All 34 false-positive calls have a populated node prompt and global-variable input, and each contains one evaluated node. The dominant defect is therefore interpretation and speaker attribution, not missing input or cross-node aggregation.

## Design

### Transcript rendering

Use one renderer for both node and full-conversation transcripts. Actual speech is rendered as `Agent: ...`; structured evidence retains its own bare label. Evidence remains available to every judge as grounding context.

This centralization addresses PR #105's review concern that duplicated rendering logic could drift and reintroduce the bug. Regression tests must prove that all evidence types remain present and that none receives an `Agent:` prefix.

### Hallucination prompt

The prompt will apply this order of operations:

1. Select candidate claims only from actual `Agent:` speech lines.
2. Exclude `Tool_Call`, `Tool_Result`, `System_Note`, and `Agent_Handoff` runtime events as accusation targets while continuing to use them as grounding evidence.
3. Apply the falsifiability test before grounding. Social language, imperatives, questions, tentative confirmations, and generic process narration are not factual claims.
4. Check every candidate against all supplied evidence fields: conversation history, current node transcript, tool/KB evidence, global and node instructions, extracted variables, global variables, and pronunciation guides.
5. Keep judge scopes separate. Forbidden behavior, sequencing, premature action, variable storage, and attribution mistakes belong to their respective judges unless the spoken message also asserts a specific unsupported fact.
6. Treat common template forms—including braced, angle-bracket, and bare variable tokens—as rendering artifacts unless the surrounding speech asserts them as resolved real values.
7. Fire only when an exact spoken claim is unsupported after the evidence search. The `technical_reason` must quote or precisely identify that claim and list the sources checked. A missing exact claim or ambiguous grounding defaults to `hallucinated=false`.

The structured output schema remains unchanged. Requiring the evidence trace inside `technical_reason` avoids an API-contract migration and preserves the current 1,500-token response budget.

### Recall boundary

This precision PR will not add a broad rule that treats every forward commitment as a hallucination. Normal process narration remains exempt, and an instruction, offered tool/handoff, or successful action grounds the corresponding path. The Round 4 replay supplied a safe discriminator for the narrower recall case: a definite promise of a concrete, externally verifiable future action is an unsupported capability claim only when no valid source establishes that action path.

## Validation

The implementation must pass:

- Unit tests for centralized transcript rendering and preservation of every evidence label.
- Prompt-calibration tests covering each audited false-positive cluster and confirmed true-positive controls.
- Existing node-judge, session-input, schema, evaluator, and calibration test suites.
- A deterministic Round 4 replay/report comparing the new hallucination verdicts with the audited ground truth. The report must show which false positives were removed, which true positives remain, any newly introduced false positives, and any newly introduced false negatives.

Live LLM replay is required when the configured provider credentials and endpoint are available. If live access is unavailable, deterministic structural and prompt-contract tests must still pass, and the PR must state that live replay remains pending rather than claiming unmeasured precision or recall.

## PR and review handling

- Update PR #105 against `dev` with this complete hallucination scope and address both inline review comments.
- Do not create a second PR against `main`.
- Update PR #106 independently with its requested low-engagement refactor, configuration guard, and distinguishing regression tests.
- Reply to each review thread only after its corresponding fix has been committed and pushed.

## Non-goals

- No changes to variable extraction, low-engagement verdict policy, or other judge prompts in PR #105.
- No database or public response-schema migration.
- No threshold tuning based only on the Round 4 aggregate count.
- No claims that all 34 false positives are fixed unless the replay demonstrates that result.
