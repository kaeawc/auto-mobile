import { type Kysely, sql } from "kysely";

/**
 * Durable, bounded postmortem records for Android emulator loss. The JSON
 * payload retains the evolving recovery attempts while the indexed columns make
 * incident lookup and retention pruning cheap.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("emulator_loss_incidents")
    .ifNotExists()
    .addColumn("incident_id", "text", (col) => col.primaryKey())
    .addColumn("device_id", "text", (col) => col.notNull())
    .addColumn("observed_at_ms", "integer", (col) => col.notNull())
    .addColumn("updated_at_ms", "integer", (col) => col.notNull())
    .addColumn("incident_json", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema
    .createIndex("idx_emulator_loss_incidents_observed")
    .ifNotExists()
    .on("emulator_loss_incidents")
    .columns(["observed_at_ms", "incident_id"])
    .execute();

  await db.schema
    .createIndex("idx_emulator_loss_incidents_device")
    .ifNotExists()
    .on("emulator_loss_incidents")
    .column("device_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("emulator_loss_incidents").execute();
}
