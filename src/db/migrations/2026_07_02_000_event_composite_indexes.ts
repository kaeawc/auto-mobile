import type { Kysely } from "kysely";

/**
 * Composite (device_id, timestamp) indexes for the telemetry event tables (#2788).
 *
 * Every event getter queries `WHERE device_id=? [AND timestamp>=?]
 * ORDER BY timestamp DESC LIMIT n`, but each table only carries single-column
 * indexes on `device_id` and `timestamp` separately. SQLite uses at most one
 * index per query, so the `device_id` equality filter forces a temp B-tree
 * filesort for the `ORDER BY timestamp DESC`. A composite `(device_id,
 * timestamp)` index lets the planner satisfy the equality filter and produce the
 * ordering from a single index — scanning it backward for the DESC order — which
 * drops the sort entirely.
 *
 * No DESC in the index columns: SQLite scans a plain ascending index backward for
 * `ORDER BY ... DESC`, so a plain composite suffices (mirrors the precedent in
 * 2025_12_30_000_performance_thresholds.ts). Additive and forward-only — the
 * existing single-column indexes are left intact because other queries and the
 * retention cleanup's full-table `ORDER BY timestamp DESC` still use the
 * standalone `timestamp` index.
 */
const TABLES = [
  "network_events",
  "log_events",
  "os_events",
  "navigation_events",
  "storage_events",
  "layout_events",
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    // .ifNotExists() so the migration survives #2785's destructive-recovery
    // replay (drop-all then replay every migration on an empty DB).
    await db.schema
      .createIndex(`idx_${table}_device_timestamp`)
      .ifNotExists()
      .on(table)
      .columns(["device_id", "timestamp"])
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    // .ifExists() so a partial-up followed by down (recovery machinery can
    // invoke migrations in unusual orders) does not throw.
    await db.schema.dropIndex(`idx_${table}_device_timestamp`).ifExists().execute();
  }
}
