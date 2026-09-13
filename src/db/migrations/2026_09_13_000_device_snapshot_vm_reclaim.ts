import type { Kysely } from "kysely";

/**
 * VM snapshot accounting and reclaim (issue #6490, parent #6371).
 *
 * `size_bytes` is NOT NULL DEFAULT 0 and SQLite cannot relax that in place, so
 * "unknown size" is carried by a sibling flag rather than a nullable column: a
 * `vm` record whose in-AVD payload could not be located is stored as
 * `size_bytes = 0, size_unknown = 1` and is reported as unsized instead of being
 * silently budgeted as zero.
 *
 * `pending_reclaim` marks a row whose in-AVD snapshot could not be deleted
 * because its emulator was offline. The row is kept (not dropped "for free")
 * so a later session can finish the reclaim when that AVD is next seen live.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("device_snapshots")
    .addColumn("size_unknown", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable("device_snapshots")
    .addColumn("pending_reclaim", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable("device_snapshots")
    .addColumn("pending_reclaim_reason", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("device_snapshots").dropColumn("pending_reclaim_reason").execute();
  await db.schema.alterTable("device_snapshots").dropColumn("pending_reclaim").execute();
  await db.schema.alterTable("device_snapshots").dropColumn("size_unknown").execute();
}
