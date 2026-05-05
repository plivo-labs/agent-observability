/**
 * One-shot backfill: recomputes per-case usage/cost from `events` and
 * re-aggregates per-run totals. Run with `bun run resummarize`.
 *
 * Safe to re-run — it overwrites the same metric columns each time.
 */
import { sql } from "../db.js";
import { computeCaseMetrics, reloadPrices } from "./summarize.js";

function parseEvents(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function main() {
  await reloadPrices();

  const cases: Array<{ case_id: string; run_id: string; events: unknown }> =
    await sql`SELECT case_id, run_id, events FROM eval_cases`;

  await sql.begin(async (tx: any) => {
    for (const row of cases) {
      const m = computeCaseMetrics(parseEvents(row.events));
      await tx`
        UPDATE eval_cases SET
          prompt_tokens        = ${m.prompt_tokens},
          cached_prompt_tokens = ${m.cached_prompt_tokens},
          completion_tokens    = ${m.completion_tokens},
          total_tokens         = ${m.total_tokens},
          estimated_cost_usd   = ${m.estimated_cost_usd}
        WHERE case_id = ${row.case_id}
      `;
    }
  });
  console.log(`[resummarize] updated ${cases.length} cases`);

  // Cost is null if any case in the run has tokens but no priced cost,
  // mirroring live ingest semantics.
  await sql`
    UPDATE eval_runs r SET
      prompt_tokens         = COALESCE(agg.prompt_tokens, 0),
      cached_prompt_tokens  = COALESCE(agg.cached_prompt_tokens, 0),
      completion_tokens     = COALESCE(agg.completion_tokens, 0),
      total_tokens          = COALESCE(agg.total_tokens, 0),
      estimated_cost_usd = CASE
        WHEN agg.has_unpriced_tokens THEN NULL
        ELSE agg.cost
      END
    FROM (
      SELECT
        run_id,
        SUM(prompt_tokens)::bigint        AS prompt_tokens,
        SUM(cached_prompt_tokens)::bigint AS cached_prompt_tokens,
        SUM(completion_tokens)::bigint    AS completion_tokens,
        SUM(total_tokens)::bigint         AS total_tokens,
        SUM(estimated_cost_usd)        AS cost,
        BOOL_OR(estimated_cost_usd IS NULL AND total_tokens > 0) AS has_unpriced_tokens
      FROM eval_cases
      GROUP BY run_id
    ) agg
    WHERE r.run_id = agg.run_id
  `;
  console.log(`[resummarize] re-aggregated runs`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
