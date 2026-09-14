import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("device_sessions")
    .addColumn("stable_identity_generation", "integer", (column) => column.notNull().defaultTo(0))
    .execute();
  // Older binaries omit stable_identity_generation from their upsert. If they
  // rebind a session to another device transport, erase identity evidence they
  // could not have refreshed before a current binary considers restart recovery.
  await sql`
    CREATE TRIGGER clear_stale_device_session_identity
    AFTER UPDATE OF device_id ON device_sessions
    WHEN NEW.device_id IS NOT OLD.device_id
      AND NEW.stable_identity_generation = OLD.stable_identity_generation
    BEGIN
      UPDATE device_sessions
      SET stable_device_id = NULL
      WHERE session_uuid = NEW.session_uuid;
    END
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS clear_stale_device_session_identity`.execute(db);
  await db.schema.alterTable("device_sessions").dropColumn("stable_identity_generation").execute();
}
