import { type Kysely, sql } from "kysely";

/** Per-reach provenance for uncorrelated fingerprints (#5001). Old suggestions
 * deliberately have no observations: their historical build/device is unknown. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("navigation_suggestion_observations")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("suggestion_id", "integer", (col) =>
      col.notNull().references("navigation_suggestions.id").onDelete("cascade"),
    )
    .addColumn("build_key_id", "integer", (col) =>
      col.notNull().references("navigation_build_keys.id").onDelete("cascade"),
    )
    .addColumn("device_id", "text", (col) => col.notNull())
    .addColumn("session_uuid", "text", (col) => col.notNull())
    .addColumn("first_seen_at", "integer", (col) => col.notNull())
    .addColumn("last_seen_at", "integer", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema
    .createIndex("idx_navigation_suggestion_observations_unique")
    .ifNotExists()
    .on("navigation_suggestion_observations")
    .columns(["suggestion_id", "build_key_id", "device_id", "session_uuid"])
    .unique()
    .execute();

  await db.schema
    .createIndex("idx_navigation_suggestion_observations_build")
    .ifNotExists()
    .on("navigation_suggestion_observations")
    .column("build_key_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("navigation_suggestion_observations").ifExists().execute();
}
