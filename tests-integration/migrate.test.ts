/**
 * Integration test for the migration runner (QUAL-02 / COR-03). Real DDL
 * against real Postgres — the unit suite mocks migrate entirely.
 */
import { test, expect, beforeAll } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { describeDb } from "./helpers.js";

describeDb("migration runner", () => {
  beforeAll(async () => {
    await migrate(sql);
  });

  test("is idempotent — repeated runs apply nothing and do not throw", async () => {
    // beforeAll already ran it once; running again must be a clean no-op.
    await migrate(sql);
    await migrate(sql);

    // Every migration file in this tree is recorded (subset check — the
    // shared dev DB may also carry historical names not in this worktree).
    const files = readdirSync(join(import.meta.dir, "../migrations")).filter((f) =>
      f.endsWith(".sql"),
    );
    const applied = new Set(
      (await sql`SELECT name FROM _migrations`).map((r: { name: string }) => r.name),
    );
    for (const f of files) {
      expect(applied.has(f)).toBe(true);
    }
  });

  test("records each migration file name exactly once", async () => {
    const rows = await sql`SELECT name, COUNT(*)::int AS c FROM _migrations GROUP BY name HAVING COUNT(*) > 1`;
    expect(rows).toHaveLength(0);
  });
});
