import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up as createDeviceSessions } from "../../src/db/migrations/2026_04_02_000_device_sessions";
import { up as stableIdentityUp } from "../../src/db/migrations/2026_09_14_000_device_session_stable_identity";
import { up as identityWriterFenceUp } from "../../src/db/migrations/2026_09_14_001_device_session_identity_writer_fence";
import {
  down as sameSerialIdentityFenceDown,
  up as sameSerialIdentityFenceUp,
} from "../../src/db/migrations/2026_09_17_001_device_session_identity_fence_same_serial";

async function columnNames(db: Kysely<unknown>): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('device_sessions')
  `.execute(db);
  return result.rows.map((row) => row.name);
}

async function insertSession(
  db: Kysely<unknown>,
  sessionUuid: string,
  deviceId: string,
  stableDeviceId: string,
): Promise<void> {
  await sql`
    INSERT INTO device_sessions (
      session_uuid,
      device_id,
      stable_device_id,
      stable_identity_generation,
      platform,
      status,
      autolock_enabled,
      created_at_ms,
      last_used_at_ms,
      expires_at_ms,
      session_timeout_ms,
      heartbeat_timeout_ms
    ) VALUES (
      ${sessionUuid},
      ${deviceId},
      ${stableDeviceId},
      0,
      'android',
      'active',
      0,
      0,
      0,
      60000,
      60000,
      60000
    )
  `.execute(db);
}

async function stableDeviceId(db: Kysely<unknown>, sessionUuid: string): Promise<string | null> {
  const result = await sql<{ stable_device_id: string | null }>`
    SELECT stable_device_id FROM device_sessions
    WHERE session_uuid = ${sessionUuid}
  `.execute(db);
  return result.rows[0]?.stable_device_id ?? null;
}

describe("device session identity fence migrations", () => {
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

  test("rolls back the identity generation column when trigger creation fails", async () => {
    // Fail the statement after ALTER TABLE has succeeded. This directly proves
    // the explicit transaction prevents a torn schema before the ledger advances.
    const originalPrepare = bunDb.prepare;
    bunDb.prepare = ((query: string) => {
      if (query.includes("CREATE TRIGGER clear_stale_device_session_identity")) {
        throw new Error("injected trigger creation failure");
      }
      return originalPrepare.call(bunDb, query);
    }) as typeof bunDb.prepare;

    try {
      await expect(identityWriterFenceUp(db)).rejects.toThrow("injected trigger creation failure");
    } finally {
      bunDb.prepare = originalPrepare;
    }

    expect(await columnNames(db)).not.toContain("stable_identity_generation");
  });

  test("repairs a prior partial identity fence without adding the column twice", async () => {
    await db.schema
      .alterTable("device_sessions")
      .addColumn("stable_identity_generation", "integer", (column) => column.notNull().defaultTo(0))
      .execute();

    await identityWriterFenceUp(db);

    expect(await columnNames(db)).toContain("stable_identity_generation");
    const trigger = await sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name = 'clear_stale_device_session_identity'
    `.execute(db);
    expect(trigger.rows).toEqual([{ name: "clear_stale_device_session_identity" }]);
  });

  test("installs the same-serial identity fence after the prior identity migration", async () => {
    await stableIdentityUp(db);
    await identityWriterFenceUp(db);
    await sameSerialIdentityFenceUp(db);

    const trigger = await sql<{ sql: string }>`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'clear_stale_device_session_identity'
    `.execute(db);
    expect(trigger.rows[0]?.sql).toContain("AFTER UPDATE OF device_id, stable_device_id");
    expect(trigger.rows[0]?.sql).toContain("OLD.stable_device_id IS NOT NULL");
    expect(trigger.rows[0]?.sql).not.toContain("NEW.device_id IS NOT OLD.device_id");
  });

  test("restores the previous changed-serial trigger on rollback", async () => {
    await stableIdentityUp(db);
    await identityWriterFenceUp(db);
    await sameSerialIdentityFenceUp(db);
    await sameSerialIdentityFenceDown(db);

    const trigger = await sql<{ sql: string }>`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'clear_stale_device_session_identity'
    `.execute(db);
    expect(trigger.rows[0]?.sql).toContain("AFTER UPDATE OF device_id ON device_sessions");
    expect(trigger.rows[0]?.sql).toContain("NEW.device_id IS NOT OLD.device_id");
    expect(trigger.rows[0]?.sql).not.toContain("stable_device_id ON device_sessions");
  });

  test("clears legacy identity writes while retaining generation-aware and heartbeat writes", async () => {
    await stableIdentityUp(db);
    await identityWriterFenceUp(db);
    await sameSerialIdentityFenceUp(db);
    await insertSession(db, "same-serial", "emulator-5554", "Pixel_8_API_35");
    await insertSession(db, "changed-serial", "emulator-5554", "Pixel_8_API_35");
    await insertSession(db, "current-writer", "emulator-5554", "Pixel_8_API_35");
    await insertSession(db, "heartbeat", "emulator-5554", "Pixel_8_API_35");

    // A legacy upsert includes known identity fields even when the transport
    // serial is reused, but it cannot advance the new generation column.
    await sql`
      UPDATE device_sessions
      SET device_id = device_id,
          stable_device_id = stable_device_id
      WHERE session_uuid = 'same-serial'
    `.execute(db);
    await sql`
      UPDATE device_sessions
      SET device_id = 'emulator-5556'
      WHERE session_uuid = 'changed-serial'
    `.execute(db);
    await sql`
      INSERT INTO device_sessions (
        session_uuid,
        device_id,
        stable_device_id,
        stable_identity_generation,
        platform,
        status,
        autolock_enabled,
        created_at_ms,
        last_used_at_ms,
        expires_at_ms,
        session_timeout_ms,
        heartbeat_timeout_ms
      ) VALUES (
        'current-writer',
        'emulator-5556',
        'Pixel_8_API_35',
        0,
        'android',
        'active',
        0,
        0,
        0,
        60000,
        60000,
        60000
      ) ON CONFLICT(session_uuid) DO UPDATE SET
        device_id = excluded.device_id,
        stable_device_id = excluded.stable_device_id,
        stable_identity_generation = stable_identity_generation + 1
    `.execute(db);
    await sql`
      UPDATE device_sessions
      SET last_used_at_ms = 1000,
          expires_at_ms = 61000,
          session_timeout_ms = 60000,
          heartbeat_timeout_ms = 60000
      WHERE session_uuid = 'heartbeat'
    `.execute(db);

    expect(await stableDeviceId(db, "same-serial")).toBeNull();
    expect(await stableDeviceId(db, "changed-serial")).toBeNull();
    expect(await stableDeviceId(db, "current-writer")).toBe("Pixel_8_API_35");
    expect(await stableDeviceId(db, "heartbeat")).toBe("Pixel_8_API_35");
  });
});
