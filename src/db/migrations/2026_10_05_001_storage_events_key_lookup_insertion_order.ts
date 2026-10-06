import type { Kysely } from "kysely";

/**
 * Seek index for `recordStorageEvent`'s previous-value lookup after it moved
 * from device-clock ordering to insertion ordering (#10044 follow-up):
 *
 *   SELECT value FROM storage_events
 *   WHERE device_id=? AND file_name=? AND key=?
 *   ORDER BY id DESC LIMIT 1
 *
 * `timestamp` is stamped by the DEVICE, so a lagging or reset device clock
 * (snapshot restore, time change) made `ORDER BY timestamp DESC` return an older
 * row than the one most recently stored. `id` (INTEGER PRIMARY KEY) is the
 * insertion order.
 *
 * `idx_storage_events_key_lookup (device_id, file_name, key, timestamp)` cannot
 * serve `ORDER BY id`: SQLite plans it as a prefix seek plus
 * `USE TEMP B-TREE FOR ORDER BY`, sorting every row of a chatty key on each
 * insert. SQLite appends the rowid to every index entry, so a plain
 * `(device_id, file_name, key)` index yields rows in `id` order within the
 * equality prefix and the newest row is reached with no sort.
 *
 * Additive: the older timestamp index is left in place (no remaining query needs
 * it for the lookup; dropping it is a separate follow-up). `.ifNotExists()` /
 * `.ifExists()` keep it safe under destructive-recovery replay.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("idx_storage_events_key_lookup_id")
    .ifNotExists()
    .on("storage_events")
    .columns(["device_id", "file_name", "key"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_storage_events_key_lookup_id").ifExists().execute();
}
