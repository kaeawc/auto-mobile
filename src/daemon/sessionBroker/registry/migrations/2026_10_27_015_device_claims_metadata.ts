import type { Kysely } from "kysely";

/**
 * The owner's control-socket record, as the claim files carry it, so a reader can ask a table
 * row's owner whether it still uses the device (#11811 step c).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("device_claims").addColumn("metadata", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("device_claims").dropColumn("metadata").execute();
}
