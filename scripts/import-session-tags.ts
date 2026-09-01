/**
 * Import session tags from a JSONL file — the generic backfill tool.
 *
 * One JSON object per line (see src/tag-import.ts for the contract):
 *   {"session_id": "…", "name": "transfer:human", "metadata": {"intent": "…"}}
 *   {"match_tag": "run_id:…", "name": "transfer:human", "metadata": {…}, "observed_at": "2026-08-10T12:00:00Z"}
 *
 * `match_tag` resolves the session through an EXISTING tag with that exact name
 * (a run-id tag a platform attached at ingest, for example). Ambiguous matches
 * (several sessions carry the tag) are skipped and reported, never guessed.
 *
 * Writes go through upsertSessionTag, keyed on (session_id, name, source), so
 * an import can be re-run and never collides with a tag the runtime emitted
 * under its own source.
 *
 *   DATABASE_URL=… bun run scripts/import-session-tags.ts --file tags.jsonl --source legacy_backfill [--dry-run]
 */
import { readFileSync } from "node:fs";
import { findSessionIdsByTag, sessionExists, sql, upsertSessionTag } from "../src/db.js";
import { parseTagImportRows } from "../src/tag-import.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const file = arg("--file");
const source = arg("--source") ?? "import";
const dryRun = process.argv.includes("--dry-run");
if (!file) {
  console.error("usage: bun run scripts/import-session-tags.ts --file <rows.jsonl> [--source <name>] [--dry-run]");
  process.exit(2);
}

const rows = parseTagImportRows(readFileSync(file, "utf8"));
const counts = { written: 0, unresolved: 0, ambiguous: 0, unknownSession: 0, failed: 0 };
for (const [i, row] of rows.entries()) {
  try {
    let sessionId = row.session_id ?? null;
    if (!sessionId && row.match_tag) {
      const ids = await findSessionIdsByTag(row.match_tag);
      if (ids.length === 1) sessionId = ids[0]!;
      else if (ids.length === 0) { counts.unresolved++; console.warn(`row ${i + 1}: unresolved — no session carries tag ${row.match_tag}`); continue; }
      else { counts.ambiguous++; console.warn(`row ${i + 1}: ambiguous — several sessions carry tag ${row.match_tag}, skipped`); continue; }
    }
    if (!sessionId) { counts.unresolved++; continue; }
    // ao_session_tags has no FK to sessions: refuse to write a tag nothing will
    // ever read rather than silently counting an orphan as imported.
    if (!(await sessionExists(sessionId))) { counts.unknownSession++; console.warn(`row ${i + 1}: unknown session_id, skipped`); continue; }
    if (dryRun) { counts.written++; continue; }
    await upsertSessionTag({ sessionId, name: row.name, metadata: row.metadata, source, observedAt: row.observed_at });
    counts.written++;
  } catch (e) {
    // One bad row must not abort a long backfill; it is reported and the run
    // exits non-zero so the operator re-runs after fixing it (upsert is idempotent).
    counts.failed++;
    console.error(`row ${i + 1}: failed — ${(e as Error).message}`);
  }
}
console.log(`${dryRun ? "[dry-run] would write" : "wrote"} ${counts.written} tag(s) (source=${source}); unresolved=${counts.unresolved} ambiguous=${counts.ambiguous} unknown_session=${counts.unknownSession} failed=${counts.failed} of ${rows.length} rows`);
await sql.end();
if (counts.failed > 0) process.exit(1);
