import { sql, type Kysely } from "kysely";

/**
 * One host-wide row per claimed device (#11811 step b). Dual-written beside the claim files for now;
 * nothing reads it for exclusivity until step (c).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("device_claims")
    .addColumn("platform", "text", (column) => column.notNull())
    .addColumn("device_id", "text", (column) => column.notNull())
    .addColumn("kind", "text", (column) => column.notNull())
    .addColumn("daemon_session_id", "text")
    .addColumn("pid", "integer", (column) => column.notNull())
    .addColumn("owner_token", "text", (column) => column.notNull())
    .addColumn("process_generation_token", "text")
    .addColumn("session_uuid", "text")
    .addColumn("claimed_at_ms", "integer", (column) => column.notNull())
    .addColumn("updated_at_ms", "integer", (column) => column.notNull())
    .addPrimaryKeyConstraint("device_claims_device", ["platform", "device_id"])
    .addCheckConstraint("device_claims_platform", sql`platform IN ('android', 'ios')`)
    .addCheckConstraint("device_claims_kind", sql`kind IN ('allocation', 'forward', 'slot')`)
    .addCheckConstraint(
      "device_claims_nonempty",
      sql`length(trim(device_id)) > 0 AND length(trim(owner_token)) > 0 AND pid > 0`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("device_claims").ifExists().execute();
}
