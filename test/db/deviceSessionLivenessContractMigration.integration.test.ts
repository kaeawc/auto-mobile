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

  test("rolls back the liveness generation column when trigger creation fails", async () => {
    // The duplicate trigger fails after the migration has added its column.
    // This proves the explicit transaction prevents a torn schema when a
    // late DDL statement fails before the migration ledger advances.
    await sql`
      CREATE TRIGGER clear_stale_device_session_liveness_contract
      AFTER UPDATE OF device_id ON device_sessions
      BEGIN
        SELECT 1;
      END
    `.execute(db);

    await expect(livenessWriterFenceUp(db)).rejects.toThrow(
      /trigger clear_stale_device_session_liveness_contract already exists/,
    );

    expect(await columnNames(db)).not.toContain("liveness_contract_generation");
  });
});
