import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("idx_device_sessions_released_at_ms")
    .ifNotExists()
    .on("device_sessions")
    .column("released_at_ms")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_device_sessions_released_at_ms").ifExists().execute();
}
