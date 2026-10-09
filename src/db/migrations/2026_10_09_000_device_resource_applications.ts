import type { Kysely } from "kysely";

// #6694: minimal AutoMobile-owned simulator service-override metadata. Keyed by
// the full incarnation identity (UDID + runtime + device type), never the UDID
// alone, so a runtime replacement does not inherit another incarnation's record.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("device_resource_applications")
    .ifNotExists()
    .addColumn("identity_key", "text", (column) => column.primaryKey())
    .addColumn("udid", "text", (column) => column.notNull())
    .addColumn("runtime_id", "text", (column) => column.notNull())
    .addColumn("device_type_id", "text", (column) => column.notNull())
    .addColumn("resources_json", "text", (column) => column.notNull())
    .addColumn("profile_fingerprint", "text", (column) => column.notNull())
    .addColumn("updated_at_ms", "integer", (column) => column.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("device_resource_applications").ifExists().execute();
}
