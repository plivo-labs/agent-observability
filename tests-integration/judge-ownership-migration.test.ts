import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sql } from "../src/db.js";
import { describeDb } from "./helpers.js";

const migration = readFileSync(new URL("../migrations/027_judge_account_ownership.sql", import.meta.url), "utf8");

describeDb("judge ownership upgrade", () => {
  test("backfills only unambiguous owners and supports per-account names and default upserts", async () => {
    // An isolated schema models the pre-upgrade registry, including its old
    // global unique constraint. Roll back the entire fixture after assertions.
    const rollback = new Error("fixture rollback");
    try {
      await sql.begin(async (tx: any) => {
        await tx.unsafe(`
          CREATE SCHEMA judge_ownership_upgrade_test;
          SET LOCAL search_path TO judge_ownership_upgrade_test;
          CREATE TABLE ao_judges (id text PRIMARY KEY, name text UNIQUE, type text);
          CREATE TABLE ao_agents (agent_id text PRIMARY KEY, account_id text);
          CREATE TABLE ao_agent_judges (agent_id text, judge_id text);
          INSERT INTO ao_agents VALUES ('a1', 'a'), ('a2', 'a'), ('b1', 'b'), ('blank', ' ');
          INSERT INTO ao_judges VALUES
            ('owned', 'custom_owned', 'custom'), ('mixed', 'custom_mixed', 'custom'),
            ('unknown', 'custom_unknown', 'custom'), ('unmapped', 'custom_unmapped', 'custom'),
            ('blank', 'custom_blank', 'custom'), ('default', 'default_metric', 'default');
          INSERT INTO ao_agent_judges VALUES
            ('a1', 'owned'), ('a2', 'owned'), ('a1', 'mixed'), ('b1', 'mixed'),
            ('a1', 'unknown'), ('missing-agent', 'unknown'), ('blank', 'blank');
        `);
        await tx.unsafe(migration);
        const rows = await tx`SELECT id, account_id FROM ao_judges ORDER BY id`;
        expect(Object.fromEntries(rows.map((r: { id: string; account_id: string | null }) => [r.id, r.account_id])))
          .toEqual({ owned: "a", mixed: null, unknown: null, unmapped: null, blank: null, default: null });
        // Reapplying is harmless and must not overwrite an explicit reconciliation.
        await tx`UPDATE ao_judges SET account_id = 'operator-owner' WHERE id = 'owned'`;
        await tx.unsafe(migration);
        expect((await tx`SELECT account_id FROM ao_judges WHERE id = 'owned'`)[0].account_id).toBe("operator-owner");
        await tx`INSERT INTO ao_judges (id, name, type, account_id) VALUES
          ('duplicate-a', 'custom_same', 'custom', 'a'), ('duplicate-b', 'custom_same', 'custom', 'b')`;
        expect((await tx`SELECT count(*)::int AS n FROM ao_judges WHERE name = 'custom_same'`)[0].n).toBe(2);
        await tx`INSERT INTO ao_judges (id, name, type) VALUES ('new-default', 'default_metric', 'default')
          ON CONFLICT (name) WHERE type = 'default' DO UPDATE SET name = EXCLUDED.name`;
        expect((await tx`SELECT count(*)::int AS n FROM ao_judges WHERE type = 'default'`)[0].n).toBe(1);
        await tx`SAVEPOINT duplicate_name`;
        let duplicateRejected = false;
        try {
          await tx`INSERT INTO ao_judges (id, name, type, account_id)
            VALUES ('duplicate-a2', 'custom_same', 'custom', 'a')`;
        } catch (error) {
          duplicateRejected = (error as { errno?: string }).errno === "23505";
        }
        expect(duplicateRejected).toBe(true);
        await tx`ROLLBACK TO SAVEPOINT duplicate_name`;
        throw rollback;
      });
    } catch (err) {
      if (err !== rollback) throw err;
    }
  });
});
