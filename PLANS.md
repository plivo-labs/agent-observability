# Next 5 improvement plans

Synthesized 2026-06-10 from an internal repo review (backend, frontend, SDKs,
CI) and a survey of comparable OSS platforms (Langfuse, Arize Phoenix,
AgentOps, Laminar, Lunary, Helicone, OpenLIT, LangWatch) plus voice-agent
eval literature (LiveKit, Hamming, Coval, Canonical AI, Roark, Cekura).

Ranked by value-per-effort. Sequencing: plans 2 → 3 → 4 build on each other
(metrics feed alert presets feed dataset auto-curation); plans 1 and 5 are
independent tracks (1 is frontend-weighted, 5 is SDK-weighted).

---

> Status (2026-06-10): #2 shipped in PR #67. #1 turned out to be largely
> pre-existing (wavesurfer recording-player + playhead-synced session trace
> in `frontend/src/components/session-timeline/`) — remaining gap is at most
> transcript-click-to-seek polish. Next up: #3.

## 1. Audio playback synced to the transcript timeline — MOSTLY PRE-EXISTING

**Why:** Clearest differentiation opportunity in the competitive survey. None
of the eight comparable platforms do this well — Langfuse renders audio
inline but doesn't sync it; AgentOps' time-travel replay is text-only. Yet
LiveKit's own observability beta ships it as the flagship feature. We already
store everything needed: the OGG (S3 / `record_url`) and per-turn timestamps.
Latency gaps become *audible* in context — the voice-native version of
session replay.

**What to build:**
- Sticky `<audio>` player on the session detail page
  (`frontend/src/components/session-detail-page.tsx`).
- Click a turn in the transcript → audio seeks there
  (offset = turn timestamp − session `start_time`).
- On `timeupdate`, highlight the currently-playing turn in
  `turn-transcript.tsx`; optionally render latency gaps on a waveform strip.
- Backend: ensure `record_url` is reachable from the dashboard (signed S3
  URL endpoint if the bucket is private).

**Effort:** Frontend-weighted sprint. No new data model.

---

## 2. Voice-native conversation metrics — DONE (PR #67)

**Why:** Strongest practitioner consensus (4+ independent sources per
metric: Hamming, Coval, Canonical AI, Cekura, Roark). Almost all derivable
in `src/metrics.ts` from data already ingested. Cheapest win on the list,
and it makes the dashboard immediately more voice-native than any generic
LLM observability platform. Also lays the metric foundations plan 3's
alerting presets need.

**What to build:**
- **Interruption / barge-in rate** — LiveKit chat items carry `interrupted`
  flags on agent speech items. Count per session; per-turn badge in the
  transcript; aggregate rate summary card.
- **Dead-air / silence detection** — inter-turn gap analysis from existing
  timestamps; flag gaps over ~3s as dead-air events; % of call that is
  silence. (Canonical AI: >30% silence correlates with early hang-ups.)
  Richer v2: server-side VAD/energy analysis over the stored OGG at ingest.
- **Talk ratio, longest monologue, words-per-minute** — pure word-count /
  duration derivation from `chat_history`. (Cekura: agent talk share >0.80
  feels domineering.)
- **Time-to-first-audio (TTFA)** as the headline user-perceived latency
  metric (Hamming's #1 metric, <800ms target): EOU delay + LLM TTFT + TTS
  TTFB, with p50/p90/p95. Add end-of-utterance/endpointing delay as a
  fourth segment in the pipeline-breakdown chart — the one stage not
  decomposed today. Separate "first greeting" stat (session start → first
  agent audio).

**Effort:** A few days in `src/metrics.ts` + summary cards/chart tweaks in
`frontend/src/components/charts/`.

---

## 3. Fleet-level analytics + alerting — DONE (PR #68 analytics, PR #69 alerts)

**Why:** The dashboard is entirely per-session today; every serious
competitor has aggregate views and threshold alerts (Langfuse custom
dashboards, Lunary, OpenLIT, Helicone, LangWatch, Hamming's recommended
on-call rules). Voice agents fail in production with real callers on the
line; latency regressions are user-audible immediately.

**What to build:**
- **Aggregate analytics page** — p95 TTFA by agent over time,
  escalation/outcome rate trends, cost per account, session volume. The
  `agent_transport_sessions` table already carries all the dimensions
  (account_id, agent_id, tags, timestamps, usage).
- **Alerting** — `alert_rules` table (metric, window, threshold, webhook
  URL) + periodic aggregate job; fire to Slack/webhook. Start with 3–4
  presets: p95 TTFA, error rate, escalation rate, session-failure rate.
- Copy LangWatch's twist: an alert can auto-append offending sessions to a
  dataset (hooks into plan 4).

**Effort:** New migration + background job + one new dashboard page.

---

## 4. Close the production → eval loop

**Why:** Eval runs/cases and LLM judges exist, but there is no path from
"weird production call" to "permanent regression case" — which both Coval
and Hamming call the core discipline of voice QA ("convert every production
failure into a permanent test case").

**What to build (three composable steps):**
1. **Full-text transcript search** — Postgres `tsvector` / `pg_trgm` over
   transcript content, tool names, error strings. "Find all calls where the
   caller said 'cancel my subscription'" is the #1 triage query. Keeps the
   Postgres-only self-hosting story intact (no external search engine).
2. **"Promote session to dataset / golden set"** — one-click action on a
   session (or turn) that feeds the existing `eval_cases` tables; versioned
   datasets; eval runs compare against a pinned golden baseline with
   pass/fail thresholds.
3. **Online evals** — run judges automatically on a sample of incoming
   sessions (every Nth, or rule-matched), storing results in the existing
   `session_external_evals` substrate. Turns judging into continuous
   monitoring instead of explicit runs only.

**Effort:** Incremental — each step ships independently and builds on
existing eval infra.

---

## 5. Simulated-caller testing

**Why:** The strongest voice-specific feature in the research — Coval's core
product, Cekura's persona matrix (8+ dimensions: accent, emotion, speed,
interruption behavior, background environment), Hamming's recommended test
mix (40% happy path / 30% edge / 15% error / 10% adversarial / 5% acoustic),
LangWatch Scenario (the only competitor feature purpose-built for voice).
Converts the product from "observe" to "observe + prevent."

**What to build:**
- SDK-side test harness: an LLM-driven synthetic caller with a persona
  prompt + TTS talks to the real LiveKit/Pipecat agent over actual audio.
- The resulting session flows through the normal ingest path
  (`POST /observability/recordings/v0`) tagged `environment=simulation`, so
  results land in the same dashboard as production sessions.
- Judges grade the conversation against scenario assertions
  (Must-Always / Must-Never, task completion).
- Pairs with plan 4: golden sets become the scenario corpus.
- CI-friendly exit codes in the SDKs so regressions block deploys
  (Hamming's gate: >3% task-completion drop or >10% latency increase).

**Effort:** Biggest lift on the list; an SDK-weighted project that reuses
the eval-runs model (a scenario run is an eval run whose cases are
simulated calls).

---

## Honorable mention: OTLP GenAI trace persistence + per-turn waterfall

`POST /observability/traces/otlp/v0` currently consumes the body and
returns 200 without persisting anything (`src/index.ts:301-309`). OTel
GenAI semconv stabilized in early 2026; persisting `gen_ai.*` spans is the
lowest-friction adoption path for users who never install our SDK. UI-side:
a per-turn span waterfall (LLM call → tool calls → TTS) answers "which tool
call blew this turn's latency budget" — tool-call success rates fall out
nearly free since `function_call` payloads are already hoisted in
`src/raw-report.ts`. At minimum, the silent 200-noop should log what it
discards so clients aren't misled.

## Hygiene debt (cheap, real, not feature work)

- No size limits on the multipart ingest endpoint (`src/index.ts:66-281`);
  failed header parses are swallowed silently, saving sessions with empty
  `session_id` (`src/index.ts:92-103`).
- No data retention — JSONB chat histories and raw reports grow unbounded.
- CI: no `tsc` typecheck for the backend, no lint, zero frontend tests
  (88 source files).
- Dead "Export diff" button on the eval compare page
  (`frontend/src/components/eval-run-compare-page.tsx:257`).
- `packages/ui` registry drifted from `frontend/` (~7 components missing
  from the registry).
- Python SDK pins `livekit-agents>=1.5.2,<1.6` — breaks installs when
  1.6 ships.
