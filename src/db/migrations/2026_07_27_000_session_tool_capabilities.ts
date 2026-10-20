import { type Kysely, sql } from "kysely";

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema
    .createTable("session_tool_capabilities")
    .ifNotExists()
    .addColumn("session_uuid", "text", (col) => col.notNull())
    .addColumn("capability", "text", (col) => col.notNull())
    .addColumn("enabled", "integer", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .addPrimaryKeyConstraint("session_tool_capabilities_pk", ["session_uuid", "capability"])
    .execute();
}

export async function down<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema.dropTable("session_tool_capabilities").ifExists().execute();
}
