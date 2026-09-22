// Per-judge confidence gates. p is Jev's probability that the defect is
// present; below pass_below the axis auto-passes, at or above fail_above it
// auto-fails (Luna only writes the reason), in between Luna reviews it fully.
//
// Defaults come from the 295-session benchmark (spec §4): a flat 0.2/0.8 gate
// auto-passed 6.6% of real bots and 8.9% of real intent misses and auto-failed
// hallucination at only 67% precision, so those three judges carry their own
// values. Sentinels: pass_below -1 = never auto-pass, fail_above 2 = never
// auto-fail (a real probability is always 0..1).

export interface JudgeGate {
  pass_below: number;
  fail_above: number;
}

export type GateDecision = "pass" | "fail" | "review";

export const NEVER_PASS = -1;
export const NEVER_FAIL = 2;

export const DEFAULT_GATES: Readonly<Record<string, JudgeGate>> = {
  node_loop: { pass_below: 0.2, fail_above: 0.8 },
  intent_identification: { pass_below: 0.07, fail_above: 0.8 },
  call_screening: { pass_below: 0.2, fail_above: 0.86 },
  low_engagement: { pass_below: 0.13, fail_above: 0.8 },
  voicemail_detection: { pass_below: 0.2, fail_above: 0.8 },
  bot_detection: { pass_below: 0.07, fail_above: 0.8 },
  wrong_number: { pass_below: 0.2, fail_above: 0.8 },
  do_not_disturb: { pass_below: 0.2, fail_above: 0.8 },
  instructions_adherence: { pass_below: NEVER_PASS, fail_above: 0.8 },
  variable_extraction: { pass_below: 0.2, fail_above: 0.9 },
  hallucination: { pass_below: 0.2, fail_above: NEVER_FAIL },
  // Every custom metric (metric:<slug>) shares one gate until measured per judge.
  custom_metric: { pass_below: 0.2, fail_above: 0.8 },
};

export function decide(p: number, gate: JudgeGate): GateDecision {
  if (p <= gate.pass_below) return "pass";
  if (p >= gate.fail_above) return "fail";
  return "review";
}

export function gateFor(gates: Readonly<Record<string, JudgeGate>>, judge: string): JudgeGate | undefined {
  return gates[judge] ?? (judge.startsWith("metric:") ? gates.custom_metric : undefined);
}

function validGate(v: unknown): v is JudgeGate {
  if (!v || typeof v !== "object") return false;
  const g = v as Record<string, unknown>;
  return (
    typeof g.pass_below === "number" && typeof g.fail_above === "number" &&
    Number.isFinite(g.pass_below) && Number.isFinite(g.fail_above) &&
    g.pass_below >= NEVER_PASS && g.fail_above <= NEVER_FAIL && g.pass_below < g.fail_above
  );
}

/** Code defaults overlaid with the JEV_GATES env JSON ({judge: {pass_below,
 *  fail_above}}). A malformed document or entry is ignored with one loud line
 *  rather than failing boot: a bad ops edit must degrade to the shipped gates,
 *  not stop judging. */
export function resolveGates(override?: string | null, warn: (msg: string) => void = console.warn): Record<string, JudgeGate> {
  const gates: Record<string, JudgeGate> = { ...DEFAULT_GATES };
  if (!override || !override.trim()) return gates;
  let parsed: unknown;
  try {
    parsed = JSON.parse(override);
  } catch (e) {
    warn(`[jev] JEV_GATES is not valid JSON — using default gates: ${(e as Error).message}`);
    return gates;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn("[jev] JEV_GATES must be an object of {judge: {pass_below, fail_above}} — using default gates");
    return gates;
  }
  for (const [judge, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (validGate(value)) gates[judge] = { pass_below: value.pass_below, fail_above: value.fail_above };
    else warn(`[jev] JEV_GATES.${judge} ignored — expected {pass_below < fail_above} within [-1, 2]`);
  }
  return gates;
}
