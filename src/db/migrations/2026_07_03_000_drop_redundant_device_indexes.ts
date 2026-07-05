import type { Kysely } from "kysely";
import { EVENT_TABLES } from "../eventTables";

async function tableExists(db: Kysely<unknown>, tableName: string): Promise<boolean> {
  const result = await db
    .selectFrom("sqlite_master" as never)
    .select("name")
    .where("type", "=", "table")
    .where("name", "=", tableName)
    .execute();
  return result.length > 0;
}

/**
 * Drop the now-redundant single-column `idx_<table>_device` indexes on the six
 * telemetry event tables (#2893, follow-up to #2788 / PR #2890).
 *
 * PR #2890 added composite `(device_id, timestamp)` indexes
 * (`idx_<table>_device_timestamp`) but was deliberately kept additive-only per
 * #2788's scope ("do not modify the existing single-column indexes"). This
 * migration completes the optimization it deferred.
 *
 * A composite `(device_id, timestamp)` index serves every access path a
 * standalone `(device_id)` index can, via SQLite's left-prefix rule:
 *   - `WHERE device_id=?` — equality on the composite's leading column.
 *   - `WHERE device_id=? ORDER BY timestamp DESC` — filter + order from one index.
 *   - `COUNT(*) WHERE device_id=?` — covering scan of the composite.
 * There is no `ANALYZE`/`sqlite_stat1` in `src/db/`, so the planner chooses
 * structurally and deterministically; the standalone device index is dead weight
 * maintained on every insert for no read benefit. At the retention cap with a
 * high insert rate this is pure write amplification.
 *
 * Left intact (different query shapes — out of scope):
 *   - The standalone `timestamp` index: the retention cutoff query
 *     (`ORDER BY timestamp DESC LIMIT 1 OFFSET <cap>`, no device filter) uses it
 *     as a covering scan, and the composite CANNOT substitute because `device_id`
 *     leads the composite.
 *   - The category/content indexes (`idx_network_events_host`,
 *     `idx_log_events_tag`, `idx_os_events_category`).
 *
 * Forward-only, replay-safe (`.ifExists()` / `.ifNotExists()`) so the migration
 * survives #2785's destructive-recovery replay (drop-all then replay every
 * migration on an empty DB) in unusual orders. Sorts after
 * `2026_07_02_000_event_composite_indexes.ts`, so the composite that subsumes
 * each device index is guaranteed present when its device index is dropped.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of EVENT_TABLES) {
    // .ifExists() so replay on a DB that never had the standalone device index
    // (or a partial recovery order) does not throw.
    await db.schema.dropIndex(`idx_${table}_device`).ifExists().execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of EVENT_TABLES) {
    if (!(await tableExists(db, table))) {
      continue;
    }
    // Recreate the single-column device index exactly as the base migrations
    // defined it. .ifNotExists() so a down after a partial-up is idempotent.
    await db.schema
      .createIndex(`idx_${table}_device`)
      .ifNotExists()
      .on(table)
      .column("device_id")
      .execute();
  }
}
