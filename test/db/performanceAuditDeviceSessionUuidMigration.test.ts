import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import {
  down,
  up,
} from "../../src/db/migrations/2026_11_11_000_performance_audit_device_session_uuid";

describe("performance audit device_session_uuid migration (#17030)", () => {
  let bunDb: BunDatabase;
  let db: Kysely<unknown>;

  beforeEach(async () => {
    bunDb = new BunDatabase(":memory:");
    db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: bunDb }) });
    await sql`CREATE TABLE performance_audit_results (
      id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, timestamp TEXT NOT NULL)`.execute(db);
    await sql`INSERT INTO performance_audit_results (device_id, timestamp)
      VALUES ('emulator-5554', '2026-11-11T00:00:00.000Z')`.execute(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  const columns = () =>
    (
      bunDb.query("SELECT name FROM pragma_table_info('performance_audit_results')").all() as {
        name: string;
      }[]
    ).map((row) => row.name);

  test("up adds a nullable column, leaving existing audits unstamped", async () => {
    await up(db);
    await up(db); // idempotent
    expect(columns()).toEqual(["id", "device_id", "timestamp", "device_session_uuid"]);
    expect(bunDb.query("SELECT device_session_uuid FROM performance_audit_results").all()).toEqual([
      { device_session_uuid: null },
    ]);
  });

  test("down drops the column", async () => {
    await up(db);
    await down(db);
    expect(columns()).toEqual(["id", "device_id", "timestamp"]);
  });
});
