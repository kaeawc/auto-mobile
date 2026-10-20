import { type Kysely, sql } from "kysely";

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema
    .createTable("feature_flags")
    .ifNotExists()
    .addColumn("key", "text", (col) => col.primaryKey())
    .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("config_json", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();
}

export async function down<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema.dropTable("feature_flags").execute();
}
