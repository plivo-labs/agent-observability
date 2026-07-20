/**
 * SESSION-SIGNAL judges — conversation-axis detections decided in CODE, not by an LLM.
 *
 * From the 2026-07-18 Equate-Media capture audit. This module answers questions an
 * LLM reading a transcript structurally cannot: the transcript records WHAT was
 * said, never how long the caller waited to hear it.
 *
 * Why code and not a prompt (the LOWE-3 precedent, PR #106): when the decision is
 * a threshold over a number we already measured, an LLM adds cost, latency and
 * variance while removing determinism. The silence floor moved into code for
 * exactly this reason; dead air follows it.
 *
 * ── The availability contract (load-bearing — read before editing) ──
 * `fanOutExternalEvals` (eval-sweeper.ts) SKIPS detections with `available:false`
 * and writes `available:true, detected:false` as a PASS. So a judge whose inputs
 * are missing MUST return `unavailable(...)`, never `detected:false`. Reporting
 * "no dead air" on a session that carries no timestamps would manufacture a clean
 * verdict out of missing data — the single worst failure mode on this path.
 *
 * The judge is a pure function over already-computed values. It owns the
 * thresholds and the wording; it does not own the measurement (see src/metrics.ts).
 *
 * Two further judges (response-latency/interruption UX, and an agent script-switch
 * detector) were built alongside this one and are parked in PR #115 pending open
 * questions — the interruption flag's party attribution, and script-vs-language
 * scope. They are deliberately NOT in this PR.
 */

import type { DetectionResult } from "./conversation-judges.js";
import type { SessionMetrics } from "../../metrics.js";

/** A detection the judge could not decide, with the reason it could not. */
const unavailable = (why: string): DetectionResult => ({
  detected: false,
  reason: "",
  technical_reason: why,
  available: false,
});

/** A clean verdict: the judge ran, the inputs were present, nothing fired. */
const clean = (technicalReason: string): DetectionResult => ({
  detected: false,
  reason: "",
  technical_reason: technicalReason,
  available: true,
});

/** A fired verdict. `technical_reason` announces code provenance, matching the
 *  "derived in code:" convention `derivedDetection` established in PR #106 — it
 *  is how a stored verdict is later told apart from an LLM's. */
const fired = (reason: string, technicalReason: string): DetectionResult => ({
  detected: true,
  reason,
  technical_reason: `derived in code: ${technicalReason}`,
  available: true,
});

// ── thresholds ────────────────────────────────────────────────────────────────
// Deliberately stricter than the measurement thresholds in metrics.ts. metrics.ts
// COUNTS a gap from 3s (DEAD_AIR_THRESHOLD_MS) because that is where a gap becomes
// observable; a judge should not fail a call for one 3s pause, which is ordinary
// on a phone line. These are the "this hurt the caller" thresholds.

/**
 * A single RESPONSE silence at or above this is a defect on its own.
 *
 * ⚠️ PROVISIONAL — set by reasoning, not measured. Reference points: human
 * turn-taking gaps run ~200ms, voice-AI response targets are sub-second, ~2s
 * already reads as broken to a caller, and contact-centre dead-air standards
 * commonly flag around 3s (which is why metrics.ts measures from there). 5s sits
 * clear of that 3s measurement floor while still being lenient. Set this from the
 * observed p95 of real response gaps before treating it as validated.
 */
export const DEAD_AIR_RESPONSE_MS = 5000;
/** Or this many counted (≥3s) RESPONSE gaps in one call. */
export const DEAD_AIR_EVENT_COUNT = 3;

const secs = (ms: number) => (ms / 1000).toFixed(1);

/**
 * DEAD AIR — the agent left the caller hanging.
 *
 * Inputs: `summary.voice.dead_air`, computed in metrics.ts from turn timestamps.
 * That block is only populated when at least one gap was measurable
 * (`gapMeasured`), so its absence means "this session carried no timestamps",
 * which is unavailable — NOT clean.
 *
 * Scores `response` gaps ONLY — caller stopped speaking, agent had not yet
 * started. That is the agent hanging, and the only half the agent is responsible
 * for.
 *
 * `inter_turn` gaps (agent stopped, caller had not yet started) are excluded
 * entirely: they measure the CALLER's think-time, so firing on them would report
 * "the agent left the caller waiting" about a pause the caller chose to take —
 * wrong verdict, backwards sentence. They ARE counted in the block's aggregates,
 * which is exactly why this reads the event list rather than `max_ms`/`count`:
 * those totals mix both kinds and cannot be un-mixed after the fact.
 */
export function evaluateDeadAir(metrics: SessionMetrics | null): DetectionResult {
  const deadAir = metrics?.summary?.voice?.dead_air;
  if (!deadAir) {
    return unavailable(
      "no turn timestamps on this session, so no gap was measurable — dead air undecidable",
    );
  }
  // The kind breakdown is mandatory, because the aggregates on the block
  // (count/max_ms/total_ms) MIX both kinds and cannot be un-mixed. Without the
  // event list there is no way to tell an agent stall from a caller pause, and
  // guessing would mean accusing the agent of the caller's think-time.
  if (!Array.isArray(deadAir.events)) {
    return unavailable(
      "dead-air totals carry no per-event kind breakdown, so agent stalls can't be separated from caller pauses — undecidable",
    );
  }

  // RESPONSE gaps only: caller stopped speaking, agent had not yet started.
  // `inter_turn` gaps (agent stopped, caller had not yet started) are the CALLER
  // thinking, and firing an agent-side defect on them would be blaming the agent
  // for the other party's hesitation. They are deliberately not scored at all.
  const responses = deadAir.events.filter((e) => e.kind === "response");
  const threshold = deadAir.threshold_ms;
  const skipped = deadAir.events.length - responses.length;
  const ignored = skipped > 0 ? `; ${skipped} inter-turn gap(s) ignored (caller think-time)` : "";

  if (responses.length === 0) {
    return clean(`no agent response gap over ${threshold}ms${ignored}`);
  }

  const count = responses.length;
  const total = responses.reduce((sum, e) => sum + e.gap_ms, 0);
  const worst = responses.reduce((acc, e) => (e.gap_ms > acc.gap_ms ? e : acc), responses[0]);

  if (worst.gap_ms >= DEAD_AIR_RESPONSE_MS) {
    return fired(
      `The agent left the caller waiting ${secs(worst.gap_ms)}s at turn ${worst.turn_number}.`,
      `longest RESPONSE gap ${worst.gap_ms}ms >= ${DEAD_AIR_RESPONSE_MS}ms; ${count} response gap(s) over ${threshold}ms totalling ${total}ms${ignored}`,
    );
  }

  if (count >= DEAD_AIR_EVENT_COUNT) {
    return fired(
      `The agent was slow to respond ${count} times, ${secs(total)}s of silence in total.`,
      `${count} RESPONSE gap(s) >= ${threshold}ms meets the count rule of ${DEAD_AIR_EVENT_COUNT}; longest ${worst.gap_ms}ms${ignored}`,
    );
  }

  return clean(
    `${count} response gap(s) over ${threshold}ms, longest ${worst.gap_ms}ms — under the ${DEAD_AIR_RESPONSE_MS}ms single-gap and ${DEAD_AIR_EVENT_COUNT}-event rules${ignored}`,
  );
}
