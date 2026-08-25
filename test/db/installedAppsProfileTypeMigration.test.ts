import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up as profileTypeMigration } from "../../src/db/migrations/2026_08_24_000_installed_apps_profile_type";
import { runMigrations } from "../../src/db/migrator";

const MIGRATION_NAME = "2026_08_24_000_installed_apps_profile_type";

function provider(): MigrationProvider {
  return {
    async getMigrations() {
      return { [MIGRATION_NAME]: { up: profileTypeMigration } };
    },
  };
}

describe("installed apps profile-type migration", () => {
  let db: Kysely<unknown>;

  beforeEach(() => {
    db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("records the migration when the column exists without migration history", async () => {
    await db.schema
      .createTable("installed_apps")
      .addColumn("device_id", "text", (column) => column.notNull())
      .addColumn("profile_type", "text")
      .execute();

    await runMigrations(db, { provider: provider(), env: {} });

    const migration = await db
      .selectFrom("kysely_migration" as any)
      .select("name")
      .where("name", "=", MIGRATION_NAME)
      .executeTakeFirst();

    expect(migration?.name).toBe(MIGRATION_NAME);

    const columns = await sql<{ name: string }>`
      SELECT name FROM pragma_table_info('installed_apps') WHERE name = 'profile_type'
    `.execute(db);
    expect(columns.rows).toHaveLength(1);
  });

  test("adds the column when it is absent", async () => {
    await db.schema
      .createTable("installed_apps")
      .addColumn("device_id", "text", (column) => column.notNull())
      .execute();

    await runMigrations(db, { provider: provider(), env: {} });

    const columns = await sql<{ name: string }>`
      SELECT name FROM pragma_table_info('installed_apps') WHERE name = 'profile_type'
    `.execute(db);
    expect(columns.rows).toHaveLength(1);
  });
});
