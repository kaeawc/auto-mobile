import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up as operationsMigration } from "../../src/db/migrations/2026_08_22_003_device_teardown_operations";
import {
  down as ownerMigrationDown,
  up as ownerMigrationUp,
} from "../../src/db/migrations/2026_08_23_000_device_teardown_operation_owner";
import { runMigrations } from "../../src/db/migrator";

const MIGRATION_NAME = "2026_08_23_000_device_teardown_operation_owner";

function provider(): MigrationProvider {
  return {
    async getMigrations() {
      return { [MIGRATION_NAME]: { up: ownerMigrationUp } };
    },
  };
}

async function ownerColumnExists(db: Kysely<unknown>): Promise<boolean> {
  const columns = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('device_teardown_operations')
    WHERE name = 'owner_token'
  `.execute(db);
  return columns.rows.length === 1;
}

describe("device teardown operation owner migration", () => {
  let db: Kysely<unknown>;

  beforeEach(() => {
    db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("recovers when the schema change already exists without migration history", async () => {
    await operationsMigration(db);
    await ownerMigrationUp(db);

    await runMigrations(db, { provider: provider(), env: {} });

    const migration = await db
      .selectFrom("kysely_migration" as any)
      .select("name")
      .where("name", "=", MIGRATION_NAME)
      .executeTakeFirst();
    expect(migration?.name).toBe(MIGRATION_NAME);
    expect(await ownerColumnExists(db)).toBe(true);
  });

  test("adds the owner token on a fresh schema and removes it on down", async () => {
    await operationsMigration(db);
    expect(await ownerColumnExists(db)).toBe(false);

    await ownerMigrationUp(db);
    expect(await ownerColumnExists(db)).toBe(true);

    await ownerMigrationDown(db);
    expect(await ownerColumnExists(db)).toBe(false);
  });
});
