// AO Eval Engine — per-judge scoring over a labelled verdict set. Pure; no LLM,
// no DB, no prod code path reads this. It exists because AO's headline numbers
// (87.5% accuracy, ~30% flag precision) are averages across ~13 heterogeneous
// judges, and an average cannot tell you WHICH judge to fix.
//
// Why Balanced Accuracy and not Accuracy/F1: Collot et al., "Choosing an LLM
// Judge" (EACL 2026 Industry) — Accuracy/Precision/F1 are sensitive to class
// imbalance and to an arbitrary positive-class choice, and can favour judges
// that distort prevalence. Youden's J is the aligned selection statistic and BA
// is a linear transform of it (J = 2·BA − 1).
//
// Why precision is emitted anyway: those authors' own caveat — "A judge with a
// higher Balanced Accuracy may still have lower precision, higher false-positive
// rates". BA selects; precision is the review burden. Both, never one.

/** One judge's verdict on one unit, paired with ground truth.
 *
 *  `judge_positive` = the judge's NAMED condition fired. `truth_positive` = it
 *  really was present. For defect-named judges (hallucination, node_loop,
 *  low_engagement, …) positive = the defect = a `fail`. For quality-named ones
 *  (instructions_adherence, intent_identification, goal:*) positive = the good
 *  outcome = a `pass`. Mapping AO's pass/fail into this convention is the
 *  adapter's job — `frontend/src/lib/aoJudgeDisplay.ts` already lists which
 *  judges are defect-named; reuse it rather than restating it here. */
export interface LabelledVerdict {
  judge_name: string;
  judge_positive: boolean;
  truth_positive: boolean;
}

export interface JudgeScore {
  judge_name: string;
  n: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  /** TP/(TP+FP). `null` when the judge never fired — not 0. */
  precision: number | null;
  /** TP/(TP+FN), a.k.a. sensitivity/TPR. `null` when truth has no positives. */
  recall: number | null;
  /** TN/(TN+FP), a.k.a. TNR. `null` when truth has no negatives. */
  specificity: number | null;
  /** (recall+specificity)/2. `null` when either side is null. */
  balanced_accuracy: number | null;
  /** recall+specificity−1 == 2·BA−1. `null` when BA is null. */
  youden_j: number | null;
  /** Raw agreement — chance-uncorrected. Reported to be compared AGAINST kappa,
   *  not to be trusted on its own. */
  accuracy: number;
  /** Chance-corrected agreement. `null` when expected agreement is 1 (kappa is
   *  undefined there — a degenerate set with one class only). */
  cohens_kappa: number | null;
}

/** x/y, or null when y is 0 — "undefined", never a silent 0. */
const ratio = (x: number, y: number): number | null => (y === 0 ? null : x / y);

export function scoreJudge(judgeName: string, rows: LabelledVerdict[]): JudgeScore {
  const mine = rows.filter((r) => r.judge_name === judgeName);
  const n = mine.length;

  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of mine) {
    if (r.judge_positive && r.truth_positive) tp++;
    else if (r.judge_positive && !r.truth_positive) fp++;
    else if (!r.judge_positive && !r.truth_positive) tn++;
    else fn++;
  }

  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const specificity = ratio(tn, tn + fp);
  const balanced_accuracy = recall == null || specificity == null ? null : (recall + specificity) / 2;
  const youden_j = balanced_accuracy == null ? null : 2 * balanced_accuracy - 1;
  const accuracy = n === 0 ? 0 : (tp + tn) / n;

  // Cohen's kappa: (po − pe)/(1 − pe), where pe is the agreement two raters
  // would reach by chance given their own marginal rates.
  let cohens_kappa: number | null = null;
  if (n > 0) {
    const po = (tp + tn) / n;
    const judgePos = (tp + fp) / n;
    const truthPos = (tp + fn) / n;
    const pe = judgePos * truthPos + (1 - judgePos) * (1 - truthPos);
    cohens_kappa = pe === 1 ? null : (po - pe) / (1 - pe);
  }

  return { judge_name: judgeName, n, tp, fp, tn, fn, precision, recall, specificity, balanced_accuracy, youden_j, accuracy, cohens_kappa };
}

/** Every judge in `rows`, worst Balanced Accuracy first — the point of the
 *  module is to surface the judge to fix, so it sorts to the top. `null` BA
 *  (nothing gradeable) sorts last: it is not a failure. */
export function scoreAll(rows: LabelledVerdict[]): JudgeScore[] {
  const names = [...new Set(rows.map((r) => r.judge_name))];
  return names
    .map((nm) => scoreJudge(nm, rows))
    .sort((a, b) => (a.balanced_accuracy ?? Infinity) - (b.balanced_accuracy ?? Infinity));
}
