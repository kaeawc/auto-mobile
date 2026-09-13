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
 *
 * ALL THREE COLUMNS ARE ADDED IN ONE TRANSACTION. Kysely's SqliteAdapter
 * reports `supportsTransactionalDdl === false`, so the migrator does NOT wrap
 * these in one — statement by statement, a crash or a failure after the first
 * `ALTER TABLE` committed would leave `size_unknown` in the schema with no
 * ledger row, and every later startup would replay from the top and die on
 * `duplicate column name: size_unknown`, wedging the daemon until someone
 * repaired the schema by hand (#6490 review). SQLite itself is perfectly happy
 * to roll DDL back, so one explicit transaction makes the trio all-or-nothing.
 * `down()` gets the same treatment for the same reason.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.schema
      .alterTable("device_snapshots")
      .addColumn("size_unknown", "integer", (col) => col.notNull().defaultTo(0))
      .execute();
    await trx.schema
      .alterTable("device_snapshots")
      .addColumn("pending_reclaim", "integer", (col) => col.notNull().defaultTo(0))
      .execute();
    await trx.schema
      .alterTable("device_snapshots")
      .addColumn("pending_reclaim_reason", "text")
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.schema.alterTable("device_snapshots").dropColumn("pending_reclaim_reason").execute();
    await trx.schema.alterTable("device_snapshots").dropColumn("pending_reclaim").execute();
    await trx.schema.alterTable("device_snapshots").dropColumn("size_unknown").execute();
  });
}
