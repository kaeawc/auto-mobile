import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up as createDeviceSessions } from "../../src/db/migrations/2026_04_02_000_device_sessions";
import {
  down as livenessWriterFenceDown,
  up as livenessWriterFenceUp,
} from "../../src/db/migrations/2026_09_17_000_device_session_liveness_writer_fence";

async function columnNames(db: Kysely<unknown>): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('device_sessions')
  `.execute(db);
  return result.rows.map((row) => row.name);
}

async function triggerSql(db: Kysely<unknown>): Promise<string | null> {
  const result = await sql<{ sql: string }>`
    SELECT sql FROM sqlite_master
    WHERE type = 'trigger' AND name = 'clear_stale_device_session_liveness_contract'
  `.execute(db);
  return result.rows[0]?.sql ?? null;
}

describe("device session liveness writer fence migration", () => {
  let bunDb: BunDatabase;
  let db: Kysely<unknown>;

  beforeEach(async () => {
    bunDb = new BunDatabase(":memory:");
    db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: bunDb }),
    });
    await createDeviceSessions(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("repairs a partial liveness fence without adding the column twice", async () => {
    await db.schema
      .alterTable("device_sessions")
      .addColumn("liveness_contract_generation", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .execute();

    await livenessWriterFenceUp(db);

    expect(
      (await columnNames(db)).filter((name) => name === "liveness_contract_generation"),
    ).toEqual(["liveness_contract_generation"]);
    expect(await triggerSql(db)).toContain("clear_stale_device_session_liveness_contract");
  });

  test("rolls back the liveness generation column when trigger creation fails", async () => {
    const originalPrepare = bunDb.prepare;
    bunDb.prepare = ((query: string) => {
      if (query.includes("CREATE TRIGGER clear_stale_device_session_liveness_contract")) {
        throw new Error("injected trigger creation failure");
      }
      return originalPrepare.call(bunDb, query);
    }) as typeof bunDb.prepare;

    try {
      await expect(livenessWriterFenceUp(db)).rejects.toThrow("injected trigger creation failure");
    } finally {
      bunDb.prepare = originalPrepare;
    }

    expect(await columnNames(db)).not.toContain("liveness_contract_generation");
  });

  test("keeps the liveness fence intact when down fails", async () => {
    await livenessWriterFenceUp(db);

    const originalPrepare = bunDb.prepare;
    bunDb.prepare = ((query: string) => {
      if (query.toLowerCase().includes('drop column "liveness_contract_generation"')) {
        throw new Error("injected liveness generation column drop failure");
      }
      return originalPrepare.call(bunDb, query);
    }) as typeof bunDb.prepare;

    try {
      await expect(livenessWriterFenceDown(db)).rejects.toThrow(
        "injected liveness generation column drop failure",
      );
    } finally {
      bunDb.prepare = originalPrepare;
    }

    expect(await columnNames(db)).toContain("liveness_contract_generation");
    expect(await triggerSql(db)).toContain("clear_stale_device_session_liveness_contract");
  });

  test("preserves the liveness writer fence trigger contract", async () => {
    await livenessWriterFenceUp(db);

    const trigger = await triggerSql(db);
    expect(trigger).toContain(
      "AFTER UPDATE OF session_timeout_ms, heartbeat_timeout_ms, has_received_heartbeat ON device_sessions",
    );
    expect(trigger).toContain(
      "WHEN NEW.liveness_contract_generation = OLD.liveness_contract_generation",
    );
    expect(trigger).toContain("heartbeat_timeout_source = NULL");
    expect(trigger).toContain("liveness_policy = NULL");
    expect(trigger).toContain("pre_cli_heartbeat_timeout_ms = NULL");
    expect(trigger).toContain("pre_cli_heartbeat_timeout_source = NULL");
    expect(trigger).toContain("pre_cli_session_timeout_ms = NULL");
  });
});
