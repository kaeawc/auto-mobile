import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("custom_events").ifExists().execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("custom_events")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("device_id", "text")
    .addColumn("timestamp", "integer", (col) => col.notNull())
    .addColumn("application_id", "text")
    .addColumn("session_id", "text")
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("properties_json", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema
    .createIndex("idx_custom_events_timestamp")
    .ifNotExists()
    .on("custom_events")
    .column("timestamp")
    .execute();

  await db.schema
    .createIndex("idx_custom_events_name")
    .ifNotExists()
    .on("custom_events")
    .column("name")
    .execute();

  await db.schema
    .createIndex("idx_custom_events_device")
    .ifNotExists()
    .on("custom_events")
    .column("device_id")
    .execute();
}
