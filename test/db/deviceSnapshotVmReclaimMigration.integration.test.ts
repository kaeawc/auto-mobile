import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import {
  down as vmReclaimDown,
  up as vmReclaimUp,
} from "../../src/db/migrations/2026_09_13_000_device_snapshot_vm_reclaim";
import { runMigrations } from "../../src/db/migrator";

const MIGRATION_NAME = "2026_09_13_000_device_snapshot_vm_reclaim";

function provider(): MigrationProvider {
  return {
    async getMigrations() {
      return { [MIGRATION_NAME]: { up: vmReclaimUp, down: vmReclaimDown } };
    },
  };
}

async function columnNames(db: Kysely<unknown>): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('device_snapshots')
  `.execute(db);
  return result.rows.map((row) => row.name);
}

describe("device snapshot VM reclaim migration (#6490)", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
    await db.schema
      .createTable("device_snapshots")
      .addColumn("snapshot_name", "text", (column) => column.primaryKey())
      .addColumn("platform", "text", (column) => column.notNull())
      .addColumn("snapshot_type", "text", (column) => column.notNull())
      .addColumn("size_bytes", "integer", (column) => column.notNull().defaultTo(0))
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("adds the unknown-size and pending-reclaim columns", async () => {
    await runMigrations(db, { provider: provider(), env: {} });

    expect(await columnNames(db)).toEqual(
      expect.arrayContaining(["size_unknown", "pending_reclaim", "pending_reclaim_reason"]),
    );
  });

  test("existing non-vm rows stay sized and not pending, so nothing is retroactively flagged", async () => {
    await db
      .insertInto("device_snapshots" as never)
      .values({
        snapshot_name: "legacy",
        platform: "android",
        snapshot_type: "full",
        size_bytes: 4096,
      } as never)
      .execute();

    await runMigrations(db, { provider: provider(), env: {} });

    const row = await db
      .selectFrom("device_snapshots" as never)
      .selectAll()
      .where("snapshot_name" as never, "=", "legacy")
      .executeTakeFirst();

    expect(row).toMatchObject({
      size_bytes: 4096,
      size_unknown: 0,
      pending_reclaim: 0,
      pending_reclaim_reason: null,
    });
  });

  test("existing android vm rows are backfilled as unsized, not as a known zero", async () => {
    // A pre-change build measured a `vm` record at the ARCHIVE directory, which
    // holds none of its bytes, so every upgraded vm row carries a size (normally
    // 0) that describes nothing. Nothing re-imports a row that already exists,
    // so leaving it "known" would keep multi-gigabyte in-AVD payloads outside
    // the budget forever while the archive reported zero unsized records
    // (#6891 review).
    await db
      .insertInto("device_snapshots" as never)
      .values({
        snapshot_name: "legacy-vm",
        platform: "android",
        snapshot_type: "vm",
        size_bytes: 0,
      } as never)
      .execute();

    await runMigrations(db, { provider: provider(), env: {} });

    expect(
      await db
        .selectFrom("device_snapshots" as never)
        .selectAll()
        .where("snapshot_name" as never, "=", "legacy-vm")
        .executeTakeFirst(),
    ).toMatchObject({ size_bytes: 0, size_unknown: 1, pending_reclaim: 0 });
  });

  test("a mid-migration failure leaves no half-applied columns behind", async () => {
    // SQLite migrations here are NOT wrapped in DDL transactions by the migrator
    // (Kysely's SqliteAdapter reports supportsTransactionalDdl === false), so an
    // `up()` that ran its ALTERs one by one could commit `size_unknown` and then
    // fail — never recording the ledger row. Every later startup would replay
    // from the top and die on `duplicate column name: size_unknown`, wedging the
    // daemon until someone repaired the schema by hand (#6490 review).
    //
    // A pre-existing `pending_reclaim` column makes the SECOND statement fail for
    // exactly that reason, so this asserts the first one is rolled back with it.
    await db.schema
      .alterTable("device_snapshots")
      .addColumn("pending_reclaim", "integer", (column) => column.notNull().defaultTo(0))
      .execute();

    await expect(vmReclaimUp(db)).rejects.toThrow(/duplicate column name: pending_reclaim/);

    expect(await columnNames(db)).not.toContain("size_unknown");
  });
});
