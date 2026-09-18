import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const existingColumn = await sql<{ name: string }>`
      SELECT name FROM pragma_table_info('device_sessions')
      WHERE name = 'liveness_contract_generation'
    `.execute(trx);

    if (existingColumn.rows.length === 0) {
      await trx.schema
        .alterTable("device_sessions")
        .addColumn("liveness_contract_generation", "integer", (column) =>
          column.notNull().defaultTo(0),
        )
        .execute();
    }

    // An older binary updates the timeout/heartbeat columns but does not know
    // about this generation or the cli-idle metadata. Erase that stale metadata
    // before a newer daemon tries to recover a mixed-version row.
    await sql`DROP TRIGGER IF EXISTS clear_stale_device_session_liveness_contract`.execute(trx);
    await sql`
      CREATE TRIGGER clear_stale_device_session_liveness_contract
      AFTER UPDATE OF session_timeout_ms, heartbeat_timeout_ms, has_received_heartbeat ON device_sessions
      WHEN NEW.liveness_contract_generation = OLD.liveness_contract_generation
      BEGIN
        UPDATE device_sessions
        SET heartbeat_timeout_source = NULL,
            liveness_policy = NULL,
            pre_cli_heartbeat_timeout_ms = NULL,
            pre_cli_heartbeat_timeout_source = NULL,
            pre_cli_session_timeout_ms = NULL
        WHERE session_uuid = NEW.session_uuid;
      END
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`DROP TRIGGER IF EXISTS clear_stale_device_session_liveness_contract`.execute(trx);
    await trx.schema
      .alterTable("device_sessions")
      .dropColumn("liveness_contract_generation")
      .execute();
  });
}
