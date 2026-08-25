import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up as installedAppsMigration } from "../../src/db/migrations/2026_01_11_000_installed_apps";
import {
  down as profileTypeMigrationDown,
  up as profileTypeMigrationUp,
} from "../../src/db/migrations/2026_08_24_000_installed_apps_profile_type";
import { runMigrations } from "../../src/db/migrator";

const MIGRATION_NAME = "2026_08_24_000_installed_apps_profile_type";

function provider(): MigrationProvider {
  return {
    async getMigrations() {
      return { [MIGRATION_NAME]: { up: profileTypeMigrationUp } };
    },
  };
}

async function profileTypeColumnExists(db: Kysely<unknown>): Promise<boolean> {
  const columns = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info('installed_apps')
    WHERE name = 'profile_type'
  `.execute(db);
  return columns.rows.length === 1;
}

describe("installed apps profile type migration", () => {
  let db: Kysely<unknown>;

  beforeEach(() => {
    db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("recovers when the column already exists without migration history", async () => {
    await installedAppsMigration(db);
    await profileTypeMigrationUp(db);
    expect(await profileTypeColumnExists(db)).toBe(true);

    // Ledger has no entry for this migration but the column is present:
    // the runner must record the ledger entry and no-op the schema change.
    await runMigrations(db, { provider: provider(), env: {} });

    const migration = await db
      .selectFrom("kysely_migration" as any)
      .select("name")
      .where("name", "=", MIGRATION_NAME)
      .executeTakeFirst();
    expect(migration?.name).toBe(MIGRATION_NAME);
    expect(await profileTypeColumnExists(db)).toBe(true);
  });

  test("is re-runnable when the column already exists", async () => {
    await installedAppsMigration(db);
    await profileTypeMigrationUp(db);

    // A second application must not throw duplicate column name.
    await profileTypeMigrationUp(db);
    expect(await profileTypeColumnExists(db)).toBe(true);
  });

  test("adds the profile type on a fresh schema and removes it on down", async () => {
    await installedAppsMigration(db);
    expect(await profileTypeColumnExists(db)).toBe(false);

    await profileTypeMigrationUp(db);
    expect(await profileTypeColumnExists(db)).toBe(true);

    await profileTypeMigrationDown(db);
    expect(await profileTypeColumnExists(db)).toBe(false);
  });
});
