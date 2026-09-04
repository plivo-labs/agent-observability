// Loads the judge registry (ao_judges) and applies default-judge prompt
// overrides to the judges' override store. Coverage-first failure posture:
// a registry read error logs loudly and leaves the last-applied (or shipped)
// prompts in place — judging never stops because the catalogue was unreadable.
import { sql } from "../db.js";
import { config } from "../config.js";
import {
  setJudgePromptOverrides,
  type JudgePromptOverride,
} from "./judges/judge-prompts.js";

export interface JudgeRegistryRow {
  id: string;
  name: string;
  display_name: string;
  description: string;
  type: "default" | "custom";
  scope: "node" | "conversation";
  kind: "llm" | "code";
  prompt: { body: string; output: string; slots?: string[]; sub_prompts?: Record<string, string> } | null;
  config: Record<string, unknown>;
  enabled: boolean;
}

export async function loadJudgeRegistry(db = sql): Promise<JudgeRegistryRow[]> {
  const rows = await db`
    SELECT id, name, display_name, description, type, scope, kind, prompt, config, enabled
    FROM ao_judges
    WHERE enabled = TRUE
    ORDER BY type, name
  `;
  return rows as unknown as JudgeRegistryRow[];
}

/** Default judges whose prompts must exist for override application to be
 *  complete; a missing one is logged (the shipped constant covers it). */
const DEFAULT_LLM_JUDGES = [
  "instructions_adherence", "intent_identification", "variable_extraction",
  "hallucination", "node_loop", "voicemail_detection", "bot_detection",
  "call_screening", "low_engagement", "wrong_number", "do_not_disturb",
  "user_sentiment", "stt", "transfer_consent",
] as const;

const REGISTRY_TTL_MS = 30_000;
let lastLoadedAt = 0;
let cached: JudgeRegistryRow[] = [];

/** Refresh the override store from the registry (TTL-cached). Never throws. */
export async function ensureJudgePromptOverrides(db = sql): Promise<void> {
  if (config.JUDGES_FROM_DB === "off") return;
  const now = Date.now();
  if (now - lastLoadedAt < REGISTRY_TTL_MS) return;
  try {
    const rows = await loadJudgeRegistry(db);
    const map = new Map<string, JudgePromptOverride>();
    for (const row of rows) {
      if (row.kind !== "llm" || row.type !== "default" || !row.prompt) continue;
      const { body, output, sub_prompts } = row.prompt;
      if (typeof body !== "string" || !body.trim() || typeof output !== "string" || !output.trim()) {
        console.error(`[evals] judge registry row ${row.name} has an empty prompt — using shipped constant`);
        continue;
      }
      map.set(row.name, { body, output, ...(sub_prompts ? { sub_prompts } : {}) });
    }
    for (const name of DEFAULT_LLM_JUDGES) {
      if (!map.has(name)) {
        console.error(`[evals] judge registry is missing default judge ${name} — using shipped constant`);
      }
    }
    setJudgePromptOverrides(map);
    cached = rows;
    lastLoadedAt = now;
  } catch (e) {
    // Keep whatever prompts are active (shipped constants on first failure).
    console.error("[evals] judge registry load failed — judging continues on current prompts:", e);
    lastLoadedAt = now; // don't hammer a broken table every session
  }
}

/** Registry rows from the last successful load (custom judges included). */
export function cachedJudgeRegistry(): readonly JudgeRegistryRow[] {
  return cached;
}

/** Test hook: force the next ensure call to reload. */
export function __resetJudgeRegistryCacheForTest(): void {
  lastLoadedAt = 0;
  cached = [];
}

// ── boot-time default sync ───────────────────────────────────────────────────
//
// The CODE is the source of truth for type='default' rows, forever. Migration
// 024 is only the initial seed: it is filename-tracked and ON CONFLICT DO
// NOTHING, so on an already-migrated deployment a shipped prompt change would
// otherwise freeze at whatever the first deploy wrote — silently judging prod
// with old prompts while code, unit tests, and fresh installs use the new
// ones. This sync runs at every boot and upserts any default row whose
// content differs from the catalogue; it also reverts hand-edited default
// rows, which is the same lock the API's 403 enforces.
import { DEFAULT_JUDGE_ROWS } from "./judge-catalogue.js";
import { jsonbParam } from "../jsonb-param.js";

export async function syncDefaultJudges(db = sql): Promise<number> {
  let updated = 0;
  for (const row of DEFAULT_JUDGE_ROWS) {
    const res = await db`
      INSERT INTO ao_judges (name, display_name, description, type, scope, kind, prompt, config)
      VALUES (${row.name}, ${row.display_name}, ${row.description}, 'default', ${row.scope}, ${row.kind},
              ${jsonbParam(row.prompt)}::text::jsonb, ${jsonbParam(row.config)}::text::jsonb)
      ON CONFLICT (name) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        scope = EXCLUDED.scope,
        kind = EXCLUDED.kind,
        prompt = EXCLUDED.prompt,
        config = EXCLUDED.config,
        updated_at = NOW()
      WHERE ao_judges.type = 'default'
        AND (ao_judges.prompt IS DISTINCT FROM EXCLUDED.prompt
          OR ao_judges.config IS DISTINCT FROM EXCLUDED.config
          OR ao_judges.display_name IS DISTINCT FROM EXCLUDED.display_name
          OR ao_judges.description IS DISTINCT FROM EXCLUDED.description
          OR ao_judges.scope IS DISTINCT FROM EXCLUDED.scope
          OR ao_judges.kind IS DISTINCT FROM EXCLUDED.kind)
      RETURNING name
    `;
    updated += res.length;
  }
  if (updated > 0) {
    console.log(`[evals] judge registry: synced ${updated} default judge row(s) to the shipped catalogue`);
    lastLoadedAt = 0; // force the next override load to pick up the new content
  }
  return updated;
}
