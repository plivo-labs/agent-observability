// Generic session-tag import: the pure input contract for
// scripts/import-session-tags.ts. One JSON object per line; each names the tag
// and how to find its session — an explicit `session_id`, or `match_tag`, an
// existing tag name to look the session up by (e.g. a run-id tag a platform
// attached at ingest). Used to backfill a fact a platform recorded elsewhere
// before its runtime emitted the tag. No platform-specific logic lives here.

export interface TagImportRow {
  session_id?: string;
  match_tag?: string;
  name: string;
  metadata: Record<string, unknown> | null;
  observed_at: Date | null;
}

export function parseTagImportRows(text: string): TagImportRow[] {
  const rows: TagImportRow[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const at = `line ${i + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(`${at}: invalid JSON (${(e as Error).message})`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${at}: expected a JSON object`);
    }
    const o = parsed as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) throw new Error(`${at}: "name" is required`);
    const session_id = typeof o.session_id === "string" && o.session_id ? o.session_id : undefined;
    const match_tag = typeof o.match_tag === "string" && o.match_tag ? o.match_tag : undefined;
    if (!session_id && !match_tag) throw new Error(`${at}: one of "session_id" or "match_tag" is required`);
    const metadata =
      o.metadata && typeof o.metadata === "object" && !Array.isArray(o.metadata)
        ? (o.metadata as Record<string, unknown>)
        : null;
    let observed_at: Date | null = null;
    if (o.observed_at !== undefined && o.observed_at !== null) {
      const d = new Date(String(o.observed_at));
      if (Number.isNaN(d.getTime())) throw new Error(`${at}: invalid "observed_at"`);
      observed_at = d;
    }
    rows.push({ session_id, match_tag, name, metadata, observed_at });
  });
  return rows;
}
