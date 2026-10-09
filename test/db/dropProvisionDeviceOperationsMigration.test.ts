import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up as createUp } from "../../src/db/migrations/2026_08_22_000_provision_device_operations";
import { up as expiryUp } from "../../src/db/migrations/2026_09_08_000_provision_device_operations_expiry";
import { up as attemptUp } from "../../src/db/migrations/2026_09_10_000_provision_device_operation_attempt";
import { up as lifecycleUp } from "../../src/db/migrations/2026_09_20_000_provision_device_lifecycle_outcome";
import {
  up as dropUp,
  down as dropDown,
} from "../../src/db/migrations/2026_10_09_001_drop_provision_device_operations";

// #11065: provisionDevice no longer takes an operationId, so its replay table is dropped.
describe("2026_10_09_001_drop_provision_device_operations migration", () => {
  let bunDb: BunDatabase;
  let db: Kysely<unknown>;

  beforeEach(async () => {
    bunDb = new BunDatabase(":memory:");
    db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: bunDb }) });
    await createUp(db);
    await expiryUp(db);
    await attemptUp(db);
    await lifecycleUp(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  function columns(): string[] {
    return bunDb
      .query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('provision_device_operations')",
      )
      .all()
      .map((row) => row.name)
      .sort();
  }

  test("drops the table and its stored rows", async () => {
    await sql`INSERT INTO provision_device_operations (operation_id, request_fingerprint, status)
      VALUES ('op-1', 'fp', 'succeeded')`.execute(db);

    await dropUp(db);

    expect(columns()).toEqual([]);
    // The tombstone table added alongside the lifecycle column is unaffected.
    expect(
      bunDb
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name = 'provisioned_device_transport_tombstones'",
        )
        .all(),
    ).toHaveLength(1);
  });

  test("is idempotent when the table is already gone", async () => {
    await dropUp(db);
    await dropUp(db);
    expect(columns()).toEqual([]);
  });

  test("down restores the final pre-drop shape", async () => {
    const before = columns();
    await dropUp(db);
    await dropDown(db);
    expect(columns()).toEqual(before);
  });
});
