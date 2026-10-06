import { sql, type Kysely } from "kysely";

const RELEASE_COLUMNS = [
  ["liveness_released_by", "text"],
  ["liveness_released_heartbeat_ms", "integer"],
  ["liveness_released_grace_ms", "integer"],
] as const;

/** Persist explicit release separately from never-owned and lapsed ownership. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const existing = await sql<{
      name: string;
    }>`SELECT name FROM pragma_table_info('device_sessions')`.execute(trx);
    for (const [name, type] of RELEASE_COLUMNS) {
      if (!existing.rows.some((column) => column.name === name)) {
        await trx.schema.alterTable("device_sessions").addColumn(name, type).execute();
      }
    }
    await sql`DROP TRIGGER IF EXISTS clear_stale_device_session_liveness_release`.execute(trx);
    // Old ownership/contract writers cannot preserve evidence they do not understand.
    await sql`
      CREATE TRIGGER clear_stale_device_session_liveness_release
      AFTER UPDATE OF liveness_owner_token, session_timeout_ms, heartbeat_timeout_ms, has_received_heartbeat ON device_sessions
      WHEN NEW.liveness_contract_generation = OLD.liveness_contract_generation
      BEGIN
        UPDATE device_sessions
        SET liveness_released_by = NULL,
            liveness_released_heartbeat_ms = NULL,
            liveness_released_grace_ms = NULL
        WHERE session_uuid = NEW.session_uuid;
      END
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`DROP TRIGGER IF EXISTS clear_stale_device_session_liveness_release`.execute(trx);
    for (const [name] of RELEASE_COLUMNS) {
      await trx.schema.alterTable("device_sessions").dropColumn(name).execute();
    }
  });
}
