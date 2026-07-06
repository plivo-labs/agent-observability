import { sql } from "./db.js";

// Pre-existing-tables contract (aodb-write.md §5): on the managed deployment the
// ao_sim_* tables are created OUT-OF-BAND in the shared core DB (dev via pgAdmin, prod
// via a goose migration) and AO runs DML-only with AUTO_MIGRATE=off — so the `_migrations`
// bookkeeping says nothing about whether these tables exist. This probe is the boot-time
// check that replaces it: cheap `LIMIT 0` selects, failing fast with an actionable message
// instead of erroring on the first live run. Callers gate on SIM_PERSIST && dbConfigured.

const SIM_TABLES = ["ao_sim_scenario", "ao_sim_run", "ao_sim_run_scenario"] as const;

/**
 * Verify every sim-persistence table is present, selectable AND writable. Throws with a
 * clear remediation message on the first failure. The write-privilege check matters on the
 * managed core-DB: grants are hand-applied there (no default privileges), and the run-path
 * writes deliberately swallow errors to protect the Redis emits — a SELECT-only role would
 * otherwise pass boot and then persist nothing, silently. (`sql.unsafe` is safe here — the
 * table names are a compile-time constant list, no user input.)
 */
export async function probeSimTables(): Promise<void> {
  for (const table of SIM_TABLES) {
    try {
      await sql.unsafe(`SELECT 1 FROM ${table} LIMIT 0`);
    } catch (err) {
      throw new Error(
        `sim-persistence table "${table}" is missing or unreadable (${(err as Error).message}). ` +
          `Apply the DDL from migrations/019+020 (OSS: set AUTO_MIGRATE=true; managed core-DB: ` +
          `hand-apply the DDL + grants), or set SIM_PERSIST=false to run without persistence.`,
      );
    }
    const [row] = await sql`
      SELECT has_table_privilege(current_user, ${table}, 'INSERT, UPDATE') AS writable
    `;
    if (!(row as { writable: boolean }).writable) {
      throw new Error(
        `sim-persistence table "${table}" is readable but NOT writable for the current DB user. ` +
          `Grant INSERT/UPDATE (managed core-DB: GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} ` +
          `TO the service role), or set SIM_PERSIST=false to run without persistence.`,
      );
    }
  }
  console.log(`[db-probe] sim-persistence tables present + writable: ${SIM_TABLES.join(", ")}`);
}
