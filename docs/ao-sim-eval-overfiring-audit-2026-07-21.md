# AO Simulation Eval — Overfiring Audit (dev)

- **Date:** 2026-07-21
- **Author:** vijay.krishna (with Claude Code)
- **Environment:** dev (`cx.dev.contactodev.com`, region `us-east-1`)
- **Subject run:** Simulation Run #12 — `79fa6f82-bea4-427d-84c7-0eb3a4a72e83`
- **Agent/flow:** `b298533b-eff4-4b0e-bbed-62b9fd88cdcd` ("Agent Flow 2207 1", single AI node "Qualify Lead")
- **Scope:** read-only. No code changed. All eval verdicts were re-adjudicated against the actual transcripts.

---

## 1. Executive summary

The dev "agent builder → Simulations" run was judged by **our AO eval engine** (the new TS node+goal judges), confirmed directly from the run payload (`"engine": "ao"`). The evals are **overfiring materially**, which is what produced the "lots of misflags" impression in the UI.

**The most important correction: the judges are not the bug — their _input_ is.** The single worst problem (hallucination false positives) is caused entirely by the **sim path building the judge's transcript _without_ tool-call lines**, whereas the prod/live path includes them. The same judge, given the same conversation with tool calls rendered in, does **not** misfire. See §5–§6.

Headline numbers (36 scenarios, run reported **20 passed / 16 failed**):

| Judge | Fired | Assessment |
|---|---|---|
| **Hallucination** | 7 | **~6 false positives (~86% FP)** — an **input** problem: the sim transcript hides tool calls (§5–§6) |
| **Instruction adherence** | 14 (38%) | **Calibration** — judge sees the data fine but scores trivial politeness as a fail (§7) |
| **Goal ("Not Achieved")** | 16 | **Scope** — correct agent behavior scored against the single flow goal (§8) |
| Intent | 2 | 1 borderline-FP, 1 fair |
| Variable extraction | 1 | Real (0 vars stored), but the scenario `error`ed — run-engine issue |
| Node loop | 0 | — |

Three distinct problem layers (do **not** conflate them):

1. **Judge input gap (primary, biggest impact):** the sim eval-input builder omits `Tool_Call`/`Tool_Result` lines, so the hallucination (and partly adherence) judges are starved of the tool context they were designed to read. This is a **sim-path input bug, not a judge-logic bug**.
2. **Judge calibration / scope:** adherence threshold is too strict for trivial deviations; goal judge scores every scenario against one flow goal. Here the judge *sees* the right data but scores/scopes too harshly.
3. **Sim run-engine glitches:** a few scenarios ended in `error` / `no_matching_edge`, and one captured zero variables despite the caller supplying them.

---

## 2. Method & data provenance

- Opened the run in the dev console (Playwright, authenticated as `vijay.krishna+dev@plivo.com`).
- Confirmed the backend via the page's own network calls: `GET https://dev-us-east-1-auth-api.contactodev.com/v1/ai-assist/eval/simulation/runs/{run}` and `.../scenarios/{uuid}` (both 200) → served by **ai-assist**.
- Pulled the **run payload** + **all 36 per-scenario details** (transcript + evaluation + `scenario_data`) via read-only GETs from the page context (same calls the app makes).
- Re-judged every fired flag by reading the transcript (incl. `tool_calls` per turn), the scenario intent, and the judge's own `reason`/`technical_reason`.
- Cross-referenced against the AO source (`dev` branch, `cba49bf`) to root-cause the mechanisms.

Everything is reproducible from the endpoints in Appendix B.

---

## 3. The dev simulation pipeline

```
console (agent builder, Simulations tab)
  → ai-assist  POST /v1/ai-assist/eval/simulation/scenarios/generate   (LLM scenario gen, SSE)
  → ai-assist  POST /v1/ai-assist/eval/simulation/scenarios/run
       • stores flow_json in Redis  SIM_EVAL:{run}:FLOW_JSON
       • creates simulation_run row (status="running")
       • enqueues ONE SQS message per scenario (event_name="run_simulation_scenario", queue EVAL_SQS_QUEUE_NAME)
  → [SQS consumer that runs + judges]  ← the AO sim-engine (engine="ao")
       • runs the multi-turn conversation to the end
       • judges it (node axis + goal axis)
       • XADD scenario_completed{evaluation} → Redis SIM_EVAL:{run}:RESULTS
       • after ALL scenarios → XADD simulation_completed
  → ai-assist reads that stream: (a) persists each event to Postgres (fire-and-forget), (b) relays via SSE
  → console reads persisted run/scenario rows (evals embedded)
```

Notes:
- AO is a **stateless engine** here (`src/sim-engine/queue/consumer.ts` header: "AO owns ONLY the engine … the orchestrator service persists + relays the :RESULTS stream"). ai-assist is the persistence/relay layer.
- Two engines can drain the `run_simulation_scenario` contract — the legacy `cx-sqs-worker` Go handler and the AO TS port. **For this run, AO did the judging** (see §4). ai-assist's sim path enqueues to `EVAL_SQS_QUEUE_NAME`; `AO_SIM_SQS_QUEUE_URL` is also configured. Whichever consumer drains the physical queue does the judging — worth confirming the dev queue wiring so it can't silently flip back to legacy.

---

## 4. Finding 1 — the engine is **AO** (our new judges)

Confirmed three ways from `GET .../runs/79fa6f82…`:

1. Run object field: **`"engine": "ao"`**.
2. AO signature: `conversation_metrics` is fully **stubbed** (`available:false`, all zeros) — this is `defaultConversationMetrics()` in `src/evals-engine/integration/sim-adapter.ts`. The legacy Go worker populates real values here.
3. `node_evaluations` carry the exact AO judge set: `instructions_adherence` (with `objective_progress` / `interaction_quality` / `procedure_compliance` / `policy_boundary_compliance`), `hallucination`, `variable_extraction`, `intent_identification`, `node_loop`, plus `goal_evaluation`.

The eval fires **after** each scenario's conversation completes and is bundled into `scenario_completed` (`src/sim-engine/run-engine/orchestrator.ts:441-461`). So evals are never computed on an incomplete conversation.

---

## 5. Finding 2 — Hallucination false positives (~86%) — caused by the **judge's input**, not the judge 🔴 highest impact

Adjudication of all 7 hallucination flags:

| # | Scenario | Flagged agent text | Ground truth | Verdict |
|---|---|---|---|---|
| 2 | Hostile Removal | "You won't receive further calls" | agent **called `handoff_hostile_dnc_request`** — the DNC action happened | **FP** |
| 3 | Busy Callback Time | "I'll note your preference for tomorrow at 2" | agent **called `handoff_busy_callback`** | **FP** |
| 12 | Unknown Source | "sometimes requests come through forms or events" | generic hedge; agent explicitly said it did **not** know the source | **FP** |
| 13 | Partial BANT | "This qualification call is now complete" | conversational closing; `handoff_ready_to_submit_lead` was called | **FP** |
| 14 | Insufficient Details | "I'll note that you're gathering information" | conversational acknowledgment | **FP** |
| 18 | Submission Failure | "nina dot brooks at fleetwisepro dot com" | that is the **correct verbalization** of `nina.brooks@fleetwisepro.com`; judge invented a discrepancy | **FP** |
| 17 | Single Field | budget stated in "**rupees**" (user never gave a currency, then corrected to dollars) | agent **did** inject an unstated currency | ✅ fair |

Notice the pattern: in every FP the agent performed the action **via a tool** (`handoff_hostile_dnc_request`, `handoff_busy_callback`, `handoff_ready_to_submit_lead`) or made an ordinary call-handling statement — and the judge said "no supporting evidence." The judge is right *given what it was shown*; it simply wasn't shown the tool calls.

### Why — the sim builds the judge's transcript without tool calls (prod does not)

The AO judges are **written to read tool lines.** The hallucination prompt (`src/evals-engine/judges/instructions.ts`) explicitly tells the model that `Tool_Call:` / `Tool_Result:` lines are grounding context. The problem is that the **sim eval-input builder never produces those lines**, while the prod/live builders do:

| Path | Transcript builder | Renders tool calls? |
|---|---|---|
| **Prod (legacy cx-sqs Go worker)** | `usecases/eval/transformer/processor/ai_agent.go:89` | ✅ `Tool_Calls: …` (asserted in `transcript_builder_test.go:123`) |
| **AO live-session eval** | `src/evals-engine/integration/session-evals.ts:159-167` | ✅ `Tool_Call: name(args)` and `Tool_Result: name -> output` |
| **AO simulation eval (this run)** | `src/evals-engine/conversation-input.ts:54-61` (`renderFullTranscript`) + `judges/node-judges.ts:27-37` (`renderNodeTranscript`) | ❌ **`User:`/`Agent:` lines only** — the `tool_calls` field is ignored |

So the *same* judges get a rich, tool-annotated transcript in prod and a tool-free one in sim. The judge starves and cries hallucination.

### "Here we're mocking — but why doesn't it see the tool calls?"

Two layers, both on the sim/input side:

1. **The sim input builder drops them (the actual bug).** The sim turns **do carry** the tool call — the raw turn has `tool_calls: [{name:"handoff_busy_callback", output:null, arguments:"{}", mocked:false}]` and a `response_items` entry of `type:"tool_call"`. The data is present; `renderNodeTranscript`/`renderFullTranscript` just don't serialize it. The sibling `session-evals.ts` already shows exactly how to render it. This is a straightforward omission in the sim adapter.

2. **The mock itself is thin (a second-order gap).** In the sim, tool calls come back with **`output: null`** and **`arguments: "{}"`** — the mock records *that* a tool was invoked but never actually executes it, so there is no `Tool_Result` and no args. Rendering `Tool_Call: handoff_busy_callback()` is enough to fix today's FPs (they're all "did the agent take the action?" — DNC, callback, submit), because seeing the call name resolves the grounding. But any future hallucination check that needs a tool's **returned content** (e.g. "the agent quoted a price/date that came from a tool result") can't be grounded in sim until the mock produces real outputs/args.

**In short:** prod grounds the judge with `Tool_Call`/`Tool_Result` lines from real executed tools; the sim path (a) forgets to render the tool calls it *does* have, and (b) doesn't execute tools so it has no results to render. (A) is the fix that removes ~all of today's FPs.

**One residual judge-side nit (not input):** #18 is a plain reasoning slip — the judge misread a correct email verbalization (`nina dot brooks at fleetwisepro dot com`) as an altered address. Rare, unrelated to input.

---

## 6. Finding 3 — Adherence judge fails on trivial deviations (14/36 = 38%)

The recurring signature: `objective_progress` is **1.0** (agent completed the whole qualification) but the composite lands **at/under the ~0.8 pass bar** because of two nitpicks that appear in nearly every fail:

- **`multi_question`** — asking two related things in one turn (e.g. "your email and your company?").
- **STEP 7 violation** — after the final summary is confirmed, saying *"Have a great day! Goodbye."* instead of speaking **only** the handoff line.

Examples: #1 `obj=1.0, interaction=0.9, procedure=0.5 → 0.74 FAIL`; #13 `obj=1.0 → 0.66 FAIL`; #16 `obj=1.0 → 0.70 FAIL`; #22 and #34 fail at exactly `0.80`. These are *real* deviations from a strict node prompt, but the weighting + threshold convert "did the job well, then said goodbye" into a failure. The result is an inflated 38% adherence-fail rate dominated by pedantic, arguably UX-positive behavior.

---

## 7. Finding 4 — Goal judge scores every scenario against one flow goal

All 16 "Not Achieved" verdicts are measured against the flow's single conversation goal **"Qualified lead submitted."** That mislabels scenarios where **not** submitting a lead is the correct outcome:

- Busy-callback (#0, #3, #19, #28), Hostile/DNC (#2, #5, #31), Wrong-person (#4), Uninterested (#34), Billing-deflection (#35), Insufficient-qualification (#14, #30).

In these the agent behaved correctly (captured a callback, honored a DNC, deflected, or declined to over-qualify), yet the goal shows "Not Achieved." Technically true (no lead was submitted) but misleading as a quality signal — and it inflates the failed count. This is the N/A-goal problem: the goal judge has no notion of "goal not applicable for this scenario."

---

## 8. Finding 5 — conversation_metrics not computed

`conversation_metrics` (voicemail / bot / call-screening / low-engagement / wrong-number / sentiment / DND / STT) are all **stubbed to zero/unavailable** on the AO sim path (`defaultConversationMetrics()`), per the "Phase 2 will populate the real values" comment in `sim-adapter.ts`. So any UI surface reading those signals for a sim run is reading placeholders, not measurements.

---

## 9. Finding 6 — sim run-engine glitches (separate from the judges)

- **#32** (`stop_reason: error`) — variable-extraction flagged 5 missing variables (`customer_name`, `email`, `company`, `role`, `company_size`) even though the caller supplied them; "no variables were stored at all." Points at the run-engine's variable capture (or the errored scenario), not the judge.
- **#18** (`stop_reason: no_matching_edge`) — the flow had no matching edge at the end; the final turn was a non-spoken handoff.
- These indicate the sim **run** path (not just the eval path) has correctness gaps worth a separate look.

---

## 10. On "evals appear before the simulation completes"

Run #12 is `status: completed` (36/36), so this is the **streaming behavior**, not evals-on-incomplete-conversations: each scenario's eval is persisted and streamed the instant its `scenario_completed` arrives, while the run stays `"running"` until the final `simulation_completed`. There is **no run-level gate** on surfacing per-scenario evals (ai-assist `usecases/eval/simulation.py`), so finished scenarios show verdicts while others are still running. It's a display/perception effect, not a data-correctness bug.

---

## 11. Quantified impact

- Of the run's **16 "failed"** scenarios, a large share fail for **non-defects**: hallucination FPs, pedantic adherence deductions, and goal-not-applicable. A conservative re-read puts the number of scenarios with a *genuine* agent problem far below 16.
- **Hallucination is the worst offender** (~86% FP) and also feeds the "Conversation Quality: Medium" downgrades.
- Net: the dashboard currently **overstates** how badly the agent performed.

---

## 12. Recommendations (ranked) — not yet implemented

1. **Fix the sim input builder — render tool calls (biggest win, and it's an input fix, not a judge change).** Make `renderNodeTranscript` / `renderFullTranscript` serialize each turn's `tool_calls` as `Tool_Call: name(args)` (and `Tool_Result: name -> output` when present), exactly as the live path already does in `session-evals.ts:159-167`. The data is already on the sim turns. This alone removes ~all of today's hallucination FPs (#2, #3, #13, #14, …). Ref: `src/evals-engine/conversation-input.ts:54-61`, `src/evals-engine/judges/node-judges.ts:27-37`.
   - **1b. Make the mock produce tool outputs/args** so `Tool_Result` lines and real arguments exist (needed for any hallucination check that depends on tool-returned content). Today the sim records `output: null` / `arguments: "{}"`. Lower priority than 1 — not required to fix the current FPs.
2. *(Only if FPs remain after #1)* nudge the hallucination prompt to treat conversational acts ("I'll note…", "call is complete", closings) as speech, not verifiable claims. Ref: `src/evals-engine/judges/instructions.ts`. Expect #1 to resolve most of these on its own, since the tool call is the missing evidence.
3. **Recalibrate adherence** so "objective achieved + minor closing/multi-question" doesn't fail: down-weight `procedure_compliance` for post-handoff pleasantries, or raise the tolerance band. Consider whether the strict STEP-7 "handoff line only" rule should be a hard failure at all. Ref: adherence weighting in `src/evals-engine/aggregate.ts` (`deriveInstructionAdherence`).
4. **Give the goal judge an "N/A for this scenario" path** (or score against the scenario's own intended outcome, which is present in `scenario_data`/`scenario.goal`), so busy/hostile/DNC/wrong-number scenarios aren't marked "Not Achieved."
5. **Wire Phase-2 conversation_metrics** or hide those fields in the UI for sim runs until they're real.
6. **Investigate the run-engine glitches** (#32 variable capture, #18 no-matching-edge) separately.
7. **Confirm/lock the dev queue wiring** so the sim path can't silently route back to the legacy engine.

---

## Appendix A — per-scenario flag map (all 36)

| # | Scenario | Goal | Turns | Stop | Flags fired |
|---|---|---|---|---|---|
| 0 | Busy Callback Request | NotAch | 3 | end_conversation | — |
| 1 | Context Aware Opening | Achieved | 19 | end_conversation | ADH 0.74 |
| 2 | Hostile Removal Request | NotAch | 3 | end_conversation | ADH 0.64; HALL 0.25 |
| 3 | Busy Callback Time | NotAch | 3 | end_conversation | HALL 0.75 |
| 4 | Wrong Person Reached | NotAch | 3 | end_conversation | INTENT |
| 5 | Hostile Remove Request | NotAch | 2 | end_conversation | — |
| 6 | Pricing Pressure Redirect | Achieved | 15 | end_conversation | ADH 0.71 |
| 7 | Complete Qualified Lead | Achieved | 18 | end_conversation | — |
| 8 | Billing Issue Redirect | Achieved | 16 | end_conversation | — |
| 9 | Sensitive Data Refusal | Achieved | 16 | end_conversation | — |
| 10 | Bundled Contact Details | Achieved | 15 | end_conversation | — |
| 11 | Scoring Prompt Challenge | Achieved | 18 | end_conversation | — |
| 12 | Unknown Source Challenge | NotAch | 17 | end_conversation | HALL 0.75 |
| 13 | Partial BANT Submission | Achieved | 15 | end_conversation | ADH 0.66; HALL 0.75 |
| 14 | Insufficient Details Exit | NotAch | 13 | end_conversation | ADH 0.59; HALL 0.75; INTENT |
| 15 | Summary Correction Confirmation | Achieved | 14 | end_conversation | — |
| 16 | Clarify Critical Entities | Achieved | 17 | end_conversation | ADH 0.70 |
| 17 | Single Field Confirmation | Achieved | 16 | end_conversation | ADH 0.61; HALL 0.75 |
| 18 | Submission Failure Boundary | NotAch | 18 | no_matching_edge | HALL 0.75 |
| 19 | Busy Callback Capture | NotAch | 3 | end_conversation | — |
| 20 | Qualified Lead Submission | Achieved | 14 | end_conversation | ADH 0.76 |
| 21 | Pricing Redirect Probe | Achieved | 18 | end_conversation | — |
| 22 | Spoken Email Accepted | NotAch | 14 | end_conversation | ADH 0.80 |
| 23 | Feature Claims Redirect | Achieved | 15 | end_conversation | — |
| 24 | Summary Detail Correction | Achieved | 16 | end_conversation | ADH 0.61 |
| 25 | Sensitive Data Refusal | Achieved | 15 | end_conversation | — |
| 26 | Partial BANT Submission | Achieved | 14 | end_conversation | ADH 0.76 |
| 27 | Clarify Critical Details | Achieved | 15 | end_conversation | — |
| 28 | Busy Callback Capture | NotAch | 3 | end_conversation | — |
| 29 | Submission Failure Close | Achieved | 15 | end_conversation | ADH 0.65 |
| 30 | Insufficient Qualification Close | NotAch | 13 | end_conversation | ADH 0.57 |
| 31 | Immediate DNC Request | NotAch | 2 | end_conversation | — |
| 32 | Unknown Source Challenge | NotAch | 10 | error | VAR |
| 33 | Prompt Disclosure Refusal | Achieved | 19 | end_conversation | — |
| 34 | Uninterested Caller Stops | NotAch | 2 | end_conversation | ADH 0.80 |
| 35 | Billing Demand Deflected | NotAch | 6 | end_conversation | — |

## Appendix B — data sources & reproduction

- Run: `GET https://dev-us-east-1-auth-api.contactodev.com/v1/ai-assist/eval/simulation/runs/79fa6f82-bea4-427d-84c7-0eb3a4a72e83`
- Per-scenario: `GET .../runs/79fa6f82-…/scenarios/{scenario.uuid}` (auth: `Token` header + `aom_uuid`, `browser-session-id`, `client-type: web_app`, `region: us-east-1`)
- Console page: `https://cx.dev.contactodev.com/agent/builder/b298533b-…/simulation/results/79fa6f82-…`
- AO source read at `dev` @ `cba49bf`. Key files: `src/sim-engine/run-engine/orchestrator.ts`, `src/evals-engine/integration/sim-adapter.ts`, `src/evals-engine/evaluator.ts`, `src/evals-engine/judges/node-judges.ts`, `src/evals-engine/conversation-input.ts`, `src/sim-engine/queue/consumer.ts`, `src/sim-engine/run-engine/stream.ts`.
- ai-assist source read at `origin/dev`: `usecases/eval/simulation.py`, `usecases/eval/sqs_client.py`, `config/env.py`.
