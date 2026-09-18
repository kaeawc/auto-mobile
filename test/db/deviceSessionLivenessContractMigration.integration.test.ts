import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up as createDeviceSessions } from "../../src/db/migrations/2026_04_02_000_device_sessions";
import { up as livenessContractUp } from "../../src/db/migrations/2026_09_16_001_device_session_liveness_contract";
import { up as livenessWriterFenceUp } from "../../src/db/migrations/2026_09_17_000_device_session_liveness_writer_fence";

async function columnNames(db: Kysely<unknown>): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('device_sessions')
  `.execute(db);
  return result.rows.map((row) => row.name);
}

describe("device session liveness contract migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
    await createDeviceSessions(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("rolls back every liveness column when a later ALTER fails", async () => {
    // Make the second ALTER fail after the first would have landed. SQLite DDL
    // is not implicitly transactional through this dialect, so this directly
    // proves the migration's explicit transaction prevents a torn schema.
    await db.schema.alterTable("device_sessions").addColumn("liveness_policy", "text").execute();

    await expect(livenessContractUp(db)).rejects.toThrow(/duplicate column name: liveness_policy/);

    expect(await columnNames(db)).not.toContain("heartbeat_timeout_source");
  });

  test("replaces a conflicting liveness writer fence trigger", async () => {
    await sql`
      CREATE TRIGGER clear_stale_device_session_liveness_contract
      AFTER UPDATE OF device_id ON device_sessions
      BEGIN
        SELECT 1;
      END
    `.execute(db);

    await expect(livenessWriterFenceUp(db)).resolves.toBeUndefined();

    expect(await columnNames(db)).toContain("liveness_contract_generation");
    const trigger = await sql<{ sql: string }>`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'clear_stale_device_session_liveness_contract'
    `.execute(db);
    expect(trigger.rows[0]?.sql).toContain(
      "AFTER UPDATE OF session_timeout_ms, heartbeat_timeout_ms, has_received_heartbeat ON device_sessions",
    );
    expect(trigger.rows[0]?.sql).toContain(
      "WHEN NEW.liveness_contract_generation = OLD.liveness_contract_generation",
    );
    expect(trigger.rows[0]?.sql).toContain("heartbeat_timeout_source = NULL");
  });
});
