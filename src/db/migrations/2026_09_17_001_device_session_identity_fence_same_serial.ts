import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const existingColumn = await sql<{ name: string }>`
      SELECT name FROM pragma_table_info('device_sessions')
      WHERE name = 'stable_identity_generation'
    `.execute(trx);

    if (existingColumn.rows.length === 0) {
      await trx.schema
        .alterTable("device_sessions")
        .addColumn("stable_identity_generation", "integer", (column) =>
          column.notNull().defaultTo(0),
        )
        .execute();
    }

    await sql`DROP TRIGGER IF EXISTS clear_stale_device_session_identity`.execute(trx);
    // `upsertActiveSession` always sets both identity columns and advances this
    // generation. `recordActivity`, `replaceLivenessOwnership`,
    // `markAutolockSession`, `markReleased`, and `markStaleActiveSessionsExpired`
    // do not set either identity column, so this scope only fences identity writes.
    await sql`
      CREATE TRIGGER clear_stale_device_session_identity
      AFTER UPDATE OF device_id, stable_device_id ON device_sessions
      WHEN NEW.stable_identity_generation = OLD.stable_identity_generation
        AND OLD.stable_device_id IS NOT NULL
      BEGIN
        UPDATE device_sessions
        SET stable_device_id = NULL
        WHERE session_uuid = NEW.session_uuid;
      END
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`DROP TRIGGER IF EXISTS clear_stale_device_session_identity`.execute(trx);
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
    `.execute(trx);
  });
}
