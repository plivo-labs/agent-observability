import { SQL } from "bun";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS_DIR = join(import.meta.dir, "../migrations");

export async function migrate(sql: SQL): Promise<void> {
  // Create migrations tracking table
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // Get already applied migrations
  const applied = await sql`SELECT name FROM _migrations ORDER BY name`;
  const appliedSet = new Set(applied.map((r: any) => r.name));

  // Read migration files sorted by name
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const filePath = join(MIGRATIONS_DIR, file);
    const content = readFileSync(filePath, "utf-8");

    console.log(`Applying migration: ${file}`);
    await sql.unsafe(content);
    await sql`INSERT INTO _migrations (name) VALUES (${file})`;
    count++;
  }

  if (count > 0) {
    console.log(`Applied ${count} migration(s)`);
  } else {
    console.log("No pending migrations");
  }
}
