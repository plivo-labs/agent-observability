/**
 * SESSION-SIGNAL judges — conversation-axis detections decided in CODE, not by an LLM.
 *
 * These are the "code judges" from the 2026-07-18 Equate-Media capture audit. Each
 * one answers a question an LLM reading a transcript structurally cannot: the
 * transcript records WHAT was said, never how long the caller waited for it, nor
 * how often the agent talked over them.
 *
 * Why code and not a prompt (the LOWE-3 precedent, PR #106): when the decision is
 * a threshold over a number we already measured, an LLM adds cost, latency and
 * variance while removing determinism. The silence floor moved into code for
 * exactly this reason; these three start there.
 *
 * ── The availability contract (load-bearing — read before editing) ──
 * `fanOutExternalEvals` (eval-sweeper.ts) SKIPS detections with `available:false`
 * and writes `available:true, detected:false` as a PASS. So a judge whose inputs
 * are missing MUST return `unavailable(...)`, never `detected:false`. Reporting
 * "no dead air" on a session that carries no timestamps would manufacture a clean
 * verdict out of missing data — the single worst failure mode on this path.
 *
 * All three judges are pure functions over already-computed values. They own the
 * thresholds and the wording; they do not own the measurement (see src/metrics.ts).
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
/** p95 of user-perceived response latency at or above this fails the call. */
export const LATENCY_P95_MS = 5000;
/** Fraction of agent turns interrupted at or above this fails the call. */
export const INTERRUPTION_RATE = 0.4;
/** Interruption rate is meaningless on a handful of turns; require a floor. */
export const INTERRUPTION_MIN_AGENT_TURNS = 5;

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

/**
 * LATENCY / INTERRUPTION UX — the call was slow, or the agent talked over the caller.
 *
 * Inputs: `summary.voice.interruptions` / `interruption_rate` and
 * `summary.p95_user_perceived_ms`, all from metrics.ts.
 *
 * Relationship to alert rules: `017_alert_rules.sql` already thresholds
 * `latency_perceived_p95` and `interruption_rate` — but as WINDOWED, FLEET-level
 * triggers ("p95 across the last N sessions exceeded X"). This judge is per-call
 * attribution: it marks the individual session as a UX defect so it shows up in
 * the eval surfaces beside the LLM verdicts. Complementary, not a replacement —
 * a fleet within its SLO can still contain individually terrible calls.
 *
 * The interruption rate is gated on a turn floor: 1 interruption out of 2 agent
 * turns is 50% and means nothing.
 */
export function evaluateLatencyUx(metrics: SessionMetrics | null): DetectionResult {
  const summary = metrics?.summary;
  const p95 = summary?.p95_user_perceived_ms;
  const rate = summary?.interruption_rate;
  const interruptions = summary?.interruptions;
  // metrics.ts derives interruption_rate against this same count (metrics.ts:539);
  // recount it here rather than back it out of the rate, which is undefined-by-zero
  // exactly when there are no agent turns.
  const agentTurns = metrics?.turns?.filter((t) => t.agent_text != null).length ?? 0;

  const haveLatency = typeof p95 === "number";
  const rateMeasurable =
    typeof rate === "number" && agentTurns >= INTERRUPTION_MIN_AGENT_TURNS;

  // Unavailable unless at least ONE axis is actually scoreable. The subtle case:
  // no latency data AND an interruption rate below the turn floor. Both axes are
  // then unscored, and falling through to a clean verdict would fan out a PASS
  // backed by nothing — the exact thing `available:false` exists to prevent.
  if (!haveLatency && !rateMeasurable) {
    return unavailable(
      typeof rate === "number"
        ? `no per-turn latency, and only ${agentTurns} agent turn(s) — under the ${INTERRUPTION_MIN_AGENT_TURNS}-turn floor for a meaningful interruption rate — response UX undecidable`
        : "no per-turn latency and no interruption data on this session — response UX undecidable",
    );
  }

  const failures: string[] = [];
  const technical: string[] = [];

  if (haveLatency && p95! >= LATENCY_P95_MS) {
    failures.push(`responses took ${secs(p95!)}s at the 95th percentile`);
    technical.push(`p95_user_perceived_ms ${Math.round(p95!)} >= ${LATENCY_P95_MS}`);
  }
  if (rateMeasurable && rate >= INTERRUPTION_RATE) {
    failures.push(
      `the agent spoke over the caller on ${Math.round(rate! * 100)}% of its turns`,
    );
    technical.push(
      `interruption_rate ${rate!.toFixed(2)} >= ${INTERRUPTION_RATE} over ${agentTurns} agent turns (${interruptions} interrupted)`,
    );
  }

  if (failures.length > 0) {
    return fired(
      `Poor response experience: ${failures.join("; ")}.`,
      technical.join("; "),
    );
  }

  // Clean, but say WHICH axes were actually checked — a call with latency data
  // and too few turns to score interruptions is not a fully clean bill of health.
  const checked: string[] = [];
  if (haveLatency) checked.push(`p95 ${Math.round(p95!)}ms < ${LATENCY_P95_MS}ms`);
  if (rateMeasurable) checked.push(`interruption rate ${rate!.toFixed(2)} < ${INTERRUPTION_RATE}`);
  else if (typeof rate === "number") {
    checked.push(`interruption rate not scored (only ${agentTurns ?? 0} agent turns, floor is ${INTERRUPTION_MIN_AGENT_TURNS})`);
  }
  return clean(checked.join("; "));
}

// ── script detection ──────────────────────────────────────────────────────────
// SCOPE, stated plainly: this detects a change of WRITING SYSTEM, not of language.
// It catches Devanagari/Arabic/CJK/Cyrillic/Greek/Hebrew/Thai appearing in an
// otherwise Latin call. It CANNOT catch Spanish-in-an-English-call — same script,
// no signal in the codepoints. That case needs an LLM and is explicitly out of
// scope here; the STT judge prompt already carries a "random language switch"
// heuristic (conversation-judges.ts) for it.
//
// Named for what it measures. A judge called "language mismatch" that silently
// misses every same-script mismatch would overclaim.

const SCRIPTS: Array<{ name: string; re: RegExp }> = [
  { name: "Devanagari", re: /[ऀ-ॿ]/u },
  { name: "Arabic", re: /[؀-ۿݐ-ݿ]/u },
  { name: "Cyrillic", re: /[Ѐ-ӿ]/u },
  { name: "Greek", re: /[Ͱ-Ͽ]/u },
  { name: "Hebrew", re: /[֐-׿]/u },
  { name: "Thai", re: /[฀-๿]/u },
  { name: "Han", re: /[一-鿿㐀-䶿]/u },
  { name: "Kana", re: /[぀-ヿ]/u },
  { name: "Hangul", re: /[가-힯ᄀ-ᇿ]/u },
  { name: "Bengali", re: /[ঀ-৿]/u },
  { name: "Tamil", re: /[஀-௿]/u },
  { name: "Telugu", re: /[ఀ-౿]/u },
];

/**
 * Split a rendered transcript into (speaker, text) pairs.
 *
 * A turn's text may itself contain newlines — `renderFullTranscript`
 * (conversation-input.ts) emits ONE array element per turn and joins with "\n",
 * so a multi-sentence agent turn lands as several physical lines of which only
 * the FIRST carries the "Agent:" prefix. Measured on the Equate-Media corpus:
 * 6/329 calls (1.8%) contain such continuation lines.
 *
 * Attributing only prefixed lines would make every continuation invisible, which
 * breaks BOTH directions: a script switch on line 2 of an agent turn is missed
 * (a fabricated clean verdict), and a caller's own non-Latin continuation line is
 * missed, so a legitimate same-script call is wrongly flagged as unilateral.
 * Continuation lines therefore inherit the speaker of the line above them.
 *
 * Reads speech only. Never the full transcript: tool payloads and System_Note
 * lines are internal and routinely carry non-Latin data the caller never heard.
 * This is the LOWE-3 lesson (commit 1dc81cc) — the silence floor mis-fired for
 * exactly this reason before it moved to speech_transcript.
 */
function speechByRole(speechTranscript: string): { agent: string[]; user: string[] } {
  const agent: string[] = [];
  const user: string[] = [];
  let current: "agent" | "user" | null = null;

  for (const rawLine of speechTranscript.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(Agent|User):\s*(.*)$/.exec(line);
    if (match) {
      current = match[1] === "Agent" ? "agent" : "user";
      const text = match[2].trim();
      if (text) (current === "agent" ? agent : user).push(text);
      continue;
    }
    // Continuation of the turn above. Before the first prefixed line there is no
    // speaker to attribute to, so such a line is dropped rather than guessed.
    if (current) (current === "agent" ? agent : user).push(line);
  }
  return { agent, user };
}

/**
 * NON-LATIN SCRIPT IN AGENT SPEECH — the agent replied in a script the rest of
 * the call was not conducted in.
 *
 * Fires when an agent speech line contains a non-Latin script while the caller's
 * side never used it. Requires the caller comparison: a call conducted entirely
 * in Hindi is correct behaviour, not a defect — only a UNILATERAL switch is.
 *
 * `expectedScript`, when the config carries one, overrides the caller comparison.
 * AO's AgentConfig has no language field today, so this is reserved for when the
 * ingest contract grows one; passing undefined is the normal path.
 */
export function evaluateAgentScriptSwitch(
  speechTranscript: string | undefined,
  expectedScript?: string,
): DetectionResult {
  if (!speechTranscript?.trim()) {
    return unavailable("no speech transcript on this session — script switch undecidable");
  }
  const { agent: agentLines, user: callerLines } = speechByRole(speechTranscript);
  if (agentLines.length === 0) {
    return unavailable("no agent speech lines in the transcript — script switch undecidable");
  }

  const agentText = agentLines.join("\n");
  const callerText = callerLines.join("\n");

  const agentScripts = SCRIPTS.filter((s) => s.re.test(agentText)).map((s) => s.name);
  if (agentScripts.length === 0) {
    return clean("agent speech is entirely Latin-script");
  }

  const callerScripts = new Set(SCRIPTS.filter((s) => s.re.test(callerText)).map((s) => s.name));
  const unilateral = expectedScript
    ? agentScripts.filter((s) => s !== expectedScript)
    : agentScripts.filter((s) => !callerScripts.has(s));

  if (unilateral.length === 0) {
    return clean(
      expectedScript
        ? `agent used ${agentScripts.join(", ")}, matching the configured ${expectedScript}`
        : `agent used ${agentScripts.join(", ")}, and so did the caller — the call was conducted in that script`,
    );
  }

  const basis = expectedScript
    ? `configured script ${expectedScript}`
    : callerScripts.size > 0
      ? `caller used ${[...callerScripts].join(", ")}`
      : "caller spoke only Latin script";
  return fired(
    `The agent replied in ${unilateral.join(", ")} when the caller did not.`,
    `agent speech matched ${unilateral.join(", ")}; ${basis}. Script-level detection only — same-script language switches are not covered.`,
  );
}
