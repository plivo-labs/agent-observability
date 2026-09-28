# Node evidence and judge contract repairs

Approved follow-up to the 160-call dev audit. Base: dev 4c8d11e (#194 and #195 merged).

## Scope

1. Share node evidence between Jev and LLM judges. Render each event once, retain event IDs and owning node, preserve revisit order, and stop context at the target node's final event. Other nodes are supporting context, never accusation targets. A later node's correction or statement cannot invalidate an earlier node's capture. Legacy inputs without a timeline retain their node-local turns and full grounding history, with an explicit overlap/unknown-chronology contract; do not invent order by matching speech. Simulation ingestion supplies its real timeline.
2. Extract the latest recorder write visible at each node's exit, including earlier cross-node writes. Exclude explicitly failed writes; retain legacy calls without result telemetry as unconfirmed attempts, not proven successful writes. Correlate by call ID when supplied, otherwise only unambiguous same-node/name pairs. Preserve source status for judging. Intent selections likewise must not treat an explicitly rejected tool as an executed handoff.
3. Intent means catalog coverage and correctness of a recorded selection, not proof of tool execution. Ask two Jev questions corresponding to not-found and wrongly-identified, using the complete configured intent list. Missing selected intent alone is not a defect. Keep flags exclusive.
4. Align Jev adherence with the final LLM pass/fail rubric: objective, critical procedure, and explicit policy boundaries. Style/minor issues, routing, recorder order, and other nodes' behavior do not fail adherence.
5. Variable extraction grades configured fields. Runtime-allowed extra names alone are not defects. Explicit confirmation eligibility still applies, but serialized recorder order alone is not a violation. Shared contract text must reach both backends and supplementary LLM reviews.

6. Add an explicit unsupported-capability Jev question for the B22 false pass; recorder-only evidence does not prove an external callback/cancellation capability. This remains a candidate under independent LLM review.

## Guardrails and verification

Keep conversation questions/gates, mandatory node/custom LLM review, custom enablement, and overflow fallback unchanged. Version changed node evidence/questions so prior calibration cannot be confused with new candidates. No production rollout or paid calls in this change.

Regression seams: ingest-to-ConversationInput; actual payloads passed to judge providers; Jev planning/reduction/policy; stored 160-call offline input replay. Minimal synthetic fixtures only, no raw customer/session exports committed. Test code behavior locally, run the repository unit suite and available type checks, and review against this spec. Local tests do not establish new model accuracy; paired live evaluator replay and held-out positive/long-call validation remain rollout requirements.

## Local validation

- Regression tests first reproduced duplicate speech, stale first-write selection, and future-write borrowing before the fixes.
- Final server suite with localhost access: 1,025 passed, two existing skips, zero failures across 73 files.
- Strict TypeScript check of changed evaluation modules and their imported dependencies passed.
- Offline replay: all 160 calls / 338 nodes preserve target event ownership and exit boundaries. All 419 extracted value sources correlate to successful recorder results. Existing value maps are unchanged under node-exit semantics: D13/D14 keep the correct earlier 19:00 capture; later 20:00 corrections no longer appear in that earlier judge evidence. Synthetic regressions cover multiple writes within a node and later-node inheritance.
- Replay still plans 833 requests, zero budget drops; maximum estimate 19,392 tokens. No new accuracy claim or live 32k coverage.

## Review follow-up

Both review axes identified grounding edge cases, now covered by regressions: failure status precedes clipped tool output; full runtime notes carry event indices and are bounded at node exit; legacy full-transcript-only grounding survives; and capability questions receive the complete configured intent/tool catalog. These are code/evidence tests, not measured model verdicts.

## Examples guiding the change

- A02: completed read-back and explicit caller confirmation match a configured confirmed-intake intent. No recorded chosen intent is not, by itself, failed identification; actual handoff execution requires separate telemetry.
- A03: a repeated question followed by a complete confirmed read-back is a minor interaction issue, not an adherence failure under the functional-completion rubric.
- A14: an opening question, caller name, and then transcript cutoff do not establish that later checklist steps were deliberately skipped.
- A01: rejecting a valid city-level service area because the agent invented a country requirement and abandoned intake remains a genuine adherence failure. Reducing false alarms must preserve this distinction.

These are evidence-review references from the original audit, not newly scored model outputs. Both review axes found no remaining implementation blockers after the follow-up. Before production promotion, run paired old/new evaluator replay and a fresh held-out set with wrong selections, missing catalog coverage, critical consent/procedure violations, minor deviations, interruptions, and long calls. Report false-pass and false-fail rates separately; do not tune thresholds on the same cases used to claim improvement.

## Database integration verification

CI exposed outdated fixtures: the frozen migration-024 seed was compared directly to current prompts without the production boot sync, and stored Jev provenance still expected evidence-v2. Integration setup now runs migrate + syncDefaultJudges, matching API/worker startup; the sweep test checks evidence-v3 and node-question-v2. The frozen migration and production boot behavior are unchanged. A fresh isolated PostgreSQL 17 run passed 114 integration tests, with 13 skips requiring Redis/queue services, and zero failures.
