# AMD-mismatch judge — blocked on an ingest signal AO does not receive

**Status:** blocked, not scheduled. **Raised:** 2026-07-20, alongside the three
code judges in `src/evals-engine/judges/session-signal-judges.ts`.

## What was asked for

The 2026-07-18 Equate-Media capture audit identified an **AMD mismatch** signature
worth judging per call:

> `voicemail_detected = 1 ∧ cx_voicemail_detected = 0` — "answering machine treated
> as a live human" — **93 calls / 30 days** on org 332 alone.

The judge would compare the telephony platform's own answering-machine detection
against what actually happened on the call, and fail the session when they disagree.

## Why it cannot be built in AO today

**AO never ingests a platform-side AMD flag.** Every ingest path was checked:

| Path | Carries an AMD/voicemail flag? |
|---|---|
| `ao_session_tags` (`src/livekit/observability.ts`) | No — free-form `name`/`metadata`; nothing writes or reads an AMD key, and the eval path never queries this table |
| `ao_session_outcomes` | No — free-form `outcome` string from `log.attributes.outcome.outcome`; not read by the eval path |
| `ao_session_agent_config.config` | No — the accepted contract is enumerated at `src/evals-engine/integration/session-evals.ts:67-85` |
| `raw_report` / `src/raw-report.ts` | No — `normalizeRawReport` special-cases only `events`, `options`, `tags`, `usage` |
| Recording header (`src/livekit/protobuf.ts:9-15`) | No — 5 fields, none telephony-related |
| Migrations | No AMD column exists in any migration |

`cx_voicemail_detected` exists **only downstream of AO, in ClickHouse**, where the
analytics layer joins AO verdicts to the legacy `flow_run_metrics` table — see
`docs/ao-quicksight-eval-report/ao-unified-us-east.sql:52`. That join is the only
place both sides of the comparison currently coexist.

This is consistent with the audit's own root-cause finding on the sender side:
AMD handoffs write **no** `function_call` (`plivo-cx-livekit controller.py:541`), and
the voicemail tool is stripped from the LLM when `detect_voicemail` is on
(`tool_factory.py:31`). The signal is invisible to every judge because it is never
emitted, not because AO drops it.

**A judge cannot compare against a signal that does not arrive.** Shipping one that
reads a field nobody populates would produce a permanently `available:false`
detection — dead code that fires on zero calls while implying the axis is covered.

## What unblocking requires

Two changes, in this order — the sender first, since AO can accept the field but
cannot invent it:

1. **Sender (plivo-cx-livekit / agent-transport):** emit the platform AMD result at
   call end. Natural carriers, cheapest first:
   - a reserved OTLP `"tag"` record (e.g. `amd:answering_machine` / `amd:human`), or
   - an `"outcome"` record with `source: "amd"`, or
   - a field on the `"agent config"` record.

   The tag route needs no AO migration — `ao_session_tags` already accepts arbitrary
   names.

2. **AO:** read it on the eval path. `getSessionEvalSource`
   (`src/evals-engine/db.ts:238-262`) would join `ao_session_tags` (or
   `ao_session_outcomes`), and the flag threads to the judges the same way
   `signals` does today for the dead-air/latency judges — an optional parameter on
   `evaluateIngestedSession` → `evaluateConversationMetrics`.

Once the flag is present, the judge itself is small: it compares the platform flag
against `cm.voicemail_detected` (the existing LLM transcript detection) and fires on
disagreement. It should live beside the other code judges in
`session-signal-judges.ts` and follow the same availability contract —
`available:false` whenever the platform flag is absent, so partial sender rollout
never manufactures clean verdicts.

## Interim coverage

Until then the mismatch remains detectable **in ClickHouse only**, via the existing
`ao-unified-us-east.sql` join. If the 93-calls/30-days figure needs monitoring
before the ingest work lands, a scheduled query over that join is the honest
stopgap — not an AO judge.
