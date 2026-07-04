import type { Kysely } from "kysely";

/**
 * Seek-reduction index for `recordStorageEvent`'s per-insert previous-value
 * lookup (#2798).
 *
 * On every storage telemetry insert that doesn't already carry `previousValue`,
 * `storageEventRepository.recordStorageEvent` runs:
 *
 *   SELECT value FROM storage_events
 *   WHERE device_id=? AND file_name=? AND key=?
 *   ORDER BY timestamp DESC LIMIT 1
 *
 * #2798 was filed against the pre-#2788 schema, where the only usable index was
 * the standalone `idx_storage_events_device` and the plan showed
 * `USE TEMP B-TREE FOR ORDER BY`. That temp B-tree is ALREADY gone: PR #2890
 * (#2788) added `idx_storage_events_device_timestamp (device_id, timestamp)` and
 * PR #2904 (#2893) dropped the standalone device index, so the composite's
 * `device_id` prefix now supplies the DESC order for free.
 *
 * What remains — and what this index fixes — is the SEEK width. With only the
 * `(device_id, timestamp)` composite the planner seeks on `device_id=?` and then
 * scans every row for that device in timestamp order, applying the `file_name=?`
 * and `key=?` filters row-by-row until the first match. A device with many
 * distinct keys makes that scan arbitrarily long. `(device_id, file_name, key,
 * timestamp)` turns the three equality predicates into a single prefix seek that
 * descends straight to the target key's rows, and the trailing `timestamp` column
 * still yields the newest row without a sort (SQLite walks the ascending index
 * backward for `ORDER BY timestamp DESC`).
 *
 * NOT a covering index (per Mira Kessler's review on #2798): the query selects
 * `value`, which is deliberately NOT in the index — `value` is an arbitrarily
 * large TEXT blob, and widening the index to make the read index-only is a bad
 * trade. The plan is a prefix seek + one rowid lookup for `value`; the name is
 * `_key_lookup` (a seek-reduction index), NOT `_covering`.
 *
 * Distinct from `idx_storage_events_device_timestamp` (#2788), not a
 * planner-redundant near-duplicate: that composite serves the device-scoped
 * getter (`WHERE device_id=? ORDER BY timestamp DESC`) and cannot serve this
 * three-equality predicate as a prefix seek; this index cannot serve the
 * device-only getter's ordering as efficiently. The planner picks each for its
 * own shape.
 *
 * Additive and forward-only, `.ifNotExists()` / `.ifExists()` so the migration
 * survives #2785's destructive-recovery replay (drop-all then replay every
 * migration on an empty DB) in unusual orders. Sorts after
 * `2026_07_03_*`, so `storage_events` exists when it runs during a full replay.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("idx_storage_events_key_lookup")
    .ifNotExists()
    .on("storage_events")
    .columns(["device_id", "file_name", "key", "timestamp"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_storage_events_key_lookup").ifExists().execute();
}
