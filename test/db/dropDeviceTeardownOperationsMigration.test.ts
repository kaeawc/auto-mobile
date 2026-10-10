import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up as createUp } from "../../src/db/migrations/2026_08_22_003_device_teardown_operations";
import { up as ownerUp } from "../../src/db/migrations/2026_08_23_000_device_teardown_operation_owner";
import {
  up as dropUp,
  down as dropDown,
} from "../../src/db/migrations/2026_10_09_002_drop_device_teardown_operations";

// #11097: deleteDevice no longer takes an operationId, so its replay table is dropped.
describe("2026_10_09_002_drop_device_teardown_operations migration", () => {
  let bunDb: BunDatabase;
  let db: Kysely<unknown>;

  beforeEach(async () => {
    bunDb = new BunDatabase(":memory:");
    db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: bunDb }) });
    await createUp(db);
    await ownerUp(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  function columns(): string[] {
    return bunDb
      .query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('device_teardown_operations')",
      )
      .all()
      .map((row) => row.name)
      .sort();
  }

  test("drops the table and its stored rows", async () => {
    await sql`INSERT INTO device_teardown_operations
      (operation_id, request_fingerprint, status, expires_at_ms)
      VALUES ('op-1', 'fp', 'completed', 1)`.execute(db);

    await dropUp(db);

    expect(columns()).toEqual([]);
  });

  test("is idempotent when the table is already gone", async () => {
    await dropUp(db);
    await dropUp(db);
    expect(columns()).toEqual([]);
  });

  test("down restores the final pre-drop shape", async () => {
    const before = columns();
    expect(before).toContain("owner_token");
    await dropUp(db);
    await dropDown(db);
    expect(columns()).toEqual(before);
  });
});
