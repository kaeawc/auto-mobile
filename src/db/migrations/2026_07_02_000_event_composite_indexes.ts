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
 * 2025_12_30_000_performance_thresholds.ts).
 *
 * Additive and forward-only, per #2788's explicit scope ("do not modify the
 * existing single-column indexes"):
 *   - The standalone `timestamp` index MUST stay — the retention cutoff query
 *     (`ORDER BY timestamp DESC LIMIT 1 OFFSET <cap>`, no device filter) uses it
 *     as a covering scan, and the composite cannot substitute because `device_id`
 *     leads the composite.
 *   - The standalone `device_id` index is now functionally redundant: the
 *     composite's `device_id` left-prefix serves every `device_id=?` access path
 *     (including `COUNT(*) WHERE device_id=?`). It is deliberately RETAINED here
 *     to keep this migration purely additive; dropping the six redundant
 *     `idx_<table>_device` indexes to cut per-insert write amplification is
 *     deferred to a follow-up so the change is reviewed on its own (see #2788).
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
