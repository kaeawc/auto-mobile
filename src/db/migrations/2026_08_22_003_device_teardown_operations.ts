import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("device_teardown_operations")
    .ifNotExists()
    .addColumn("operation_id", "text", (column) => column.primaryKey())
    .addColumn("request_fingerprint", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("result_json", "text")
    .addColumn("expires_at_ms", "integer", (column) => column.notNull())
    .addColumn("created_at", "text", (column) => column.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("updated_at", "text", (column) => column.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("device_teardown_operations").execute();
}
