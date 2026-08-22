import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("provision_device_operations")
    .ifNotExists()
    .addColumn("operation_id", "text", (column) => column.primaryKey())
    .addColumn("request_fingerprint", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("result_json", "text")
    .addColumn("error_code", "text")
    .addColumn("error_message", "text")
    .addColumn("creation_started", "integer", (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn("created_at", "text", (column) =>
      column.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .addColumn("updated_at", "text", (column) =>
      column.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("provision_device_operations").execute();
}
