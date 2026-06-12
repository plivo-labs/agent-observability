import { SQL } from "bun";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS_DIR = join(import.meta.dir, "../migrations");

// Arbitrary stable 64-bit key for the advisory lock that serializes
// migration runs across processes.
const MIGRATION_LOCK_KEY = 4915623001n;

export async function migrate(sql: SQL): Promise<void> {
  // Run the whole sequence inside ONE transaction so it is both:
  //   - serialized: pg_advisory_xact_lock blocks any other process that
  //     starts migrating concurrently (e.g. two containers booting with
  //     AUTO_MIGRATE=true) until this transaction commits — the loser then
  //     re-reads _migrations and finds nothing pending. Taken before
  //     CREATE TABLE so even the bootstrap can't race.
  //   - atomic: a migration that fails partway rolls back the DDL *and*
  //     the _migrations bookkeeping together, so a half-applied file can
  //     never wedge the schema and block the next boot.
  // (None of the migrations use CREATE INDEX CONCURRENTLY, which would be
  // illegal inside a transaction — verified at authoring time.)
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await sql.begin(async (tx: any) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;

    await tx`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    const applied = await tx`SELECT name FROM _migrations ORDER BY name`;
    const appliedSet = new Set(applied.map((r: any) => r.name));

    let count = 0;
    for (const file of files) {
      if (appliedSet.has(file)) continue;

      const content = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
      console.log(`Applying migration: ${file}`);
      await tx.unsafe(content);
      await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      count++;
    }

    if (count > 0) {
      console.log(`Applied ${count} migration(s)`);
    } else {
      console.log("No pending migrations");
    }
  });
}
