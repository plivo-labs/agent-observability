// p is Jev's probability the defect is present. Conversation gates come from a
// 295-session benchmark (a flat 0.2 auto-passed real bots), node gates from an
// 800-call reviewed replay; each pass threshold sits >= Jev's 0.07 run-to-run
// noise below the lowest real defect. Intent, adherence and hallucination never
// auto-fail: their false alarms came from missing evidence.

export interface JudgeGate {
  pass_below: number;
  fail_above: number;
}

export type GateDecision = "pass" | "fail" | "review";

export const NEVER_PASS = -1;
export const NEVER_FAIL = 2;

export const DEFAULT_GATES: Readonly<Record<string, JudgeGate>> = {
  node_loop: { pass_below: 0.28, fail_above: 0.85 },
  intent_identification: { pass_below: 0.23, fail_above: NEVER_FAIL },
  call_screening: { pass_below: 0.2, fail_above: 0.86 },
  low_engagement: { pass_below: 0.13, fail_above: 0.8 },
  voicemail_detection: { pass_below: 0.2, fail_above: 0.8 },
  bot_detection: { pass_below: 0.07, fail_above: 0.8 },
  wrong_number: { pass_below: 0.2, fail_above: 0.8 },
  do_not_disturb: { pass_below: 0.2, fail_above: 0.8 },
  instructions_adherence: { pass_below: 0.26, fail_above: NEVER_FAIL },
  variable_extraction: { pass_below: 0.19, fail_above: 0.9 },
  hallucination: { pass_below: 0.35, fail_above: NEVER_FAIL },
  // Every custom metric (metric:<slug>) shares one gate until measured per judge.
  custom_metric: { pass_below: 0.2, fail_above: 0.8 },
};

export function decide(p: number, gate: JudgeGate): GateDecision {
  if (p <= gate.pass_below) return "pass";
  if (p >= gate.fail_above) return "fail";
  return "review";
}

export const CUSTOM_METRIC_GATE = "custom_metric";

function validGate(v: unknown): v is JudgeGate {
  if (!v || typeof v !== "object") return false;
  const g = v as Record<string, unknown>;
  // Without the [0, 1] bound a typo like pass_below: 1.5 would silently
  // auto-pass every session for that judge.
  const inDomain = (v: number, sentinel: number): boolean => v === sentinel || (v >= 0 && v <= 1);
  return (
    typeof g.pass_below === "number" && typeof g.fail_above === "number" &&
    Number.isFinite(g.pass_below) && Number.isFinite(g.fail_above) &&
    inDomain(g.pass_below, NEVER_PASS) && inDomain(g.fail_above, NEVER_FAIL) &&
    g.pass_below < g.fail_above
  );
}

/** A malformed JEV_GATES document or entry is ignored with one loud line rather
 *  than failing boot: a bad ops edit must degrade to the shipped gates. */
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
    else warn(`[jev] JEV_GATES.${judge} ignored — expected {pass_below < fail_above}, each in [0, 1] (or ${NEVER_PASS} / ${NEVER_FAIL})`);
  }
  return gates;
}
