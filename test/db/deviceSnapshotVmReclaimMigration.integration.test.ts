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

  test("existing rows default to sized and not pending, so nothing is retroactively flagged", async () => {
    await db
      .insertInto("device_snapshots" as never)
      .values({ snapshot_name: "legacy", size_bytes: 4096 } as never)
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
});
