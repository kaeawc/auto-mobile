import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("session_broker_requests").addColumn("timing_json", "text").execute();
  await db.schema
    .alterTable("session_broker_requests")
    .addColumn("timing_profile_json", "text")
    .execute();
  await db.schema
    .alterTable("session_broker_requests")
    .addColumn("timing_updated_at_ms", "integer")
    .execute();
  await db.schema
    .alterTable("session_broker_resources")
    .addColumn("reuse_count", "integer", (column) => column.notNull().defaultTo(0))
    .execute();
  await db.schema
    .createIndex("session_broker_timing_window_idx")
    .on("session_broker_requests")
    .column("timing_updated_at_ms")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("session_broker_timing_window_idx").execute();
  await db.schema.alterTable("session_broker_resources").dropColumn("reuse_count").execute();
  await db.schema
    .alterTable("session_broker_requests")
    .dropColumn("timing_updated_at_ms")
    .execute();
  await db.schema.alterTable("session_broker_requests").dropColumn("timing_profile_json").execute();
  await db.schema.alterTable("session_broker_requests").dropColumn("timing_json").execute();
}
