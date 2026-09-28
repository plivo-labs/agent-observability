# Node evidence and judge contract repairs

Approved follow-up to the 160-call dev audit. Base: dev 4c8d11e (#194 and #195 merged).

## Scope

1. Share node evidence between Jev and LLM judges. Render each event once, retain event IDs and owning node, preserve revisit order, and stop context at the target node's final event. Other nodes are supporting context, never accusation targets. A later node's correction or statement cannot invalidate an earlier node's capture. Legacy inputs without a timeline retain their node-local turns and clearly mark unavailable cross-node chronology; do not invent order from grouping. Simulation ingestion supplies its real timeline.
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
- Server suite: 1,011 passed, two skipped; sandbox prevented one local server fixture from binding. That entire fixture passed all ten tests outside the sandbox.
- Strict TypeScript check of changed evaluation modules and their imported dependencies passed.
- Offline replay: all 160 calls / 338 nodes preserve target event ownership and exit boundaries. All 419 extracted value sources correlate to successful recorder results. Existing value maps are unchanged under node-exit semantics: D13/D14 keep the correct earlier 19:00 capture; later 20:00 corrections no longer appear in that earlier judge evidence. Synthetic regressions cover multiple writes within a node and later-node inheritance.
- Replay still plans 833 requests, zero budget drops; maximum estimate 19,010 tokens. No new accuracy claim or live 32k coverage.
