import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up as ownerSessionMigration } from "../../src/db/migrations/2026_07_31_000_video_recordings_owner_session";
import { runMigrations } from "../../src/db/migrator";

const MIGRATION_NAME = "2026_07_31_000_video_recordings_owner_session";

function provider(): MigrationProvider {
  return {
    async getMigrations() {
      return { [MIGRATION_NAME]: { up: ownerSessionMigration } };
    },
  };
}

describe("video recordings owner-session migration", () => {
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
    await db.schema
      .createTable("video_recordings")
      .addColumn("id", "integer", column => column.primaryKey())
      .addColumn("owner_session_uuid", "text")
      .execute();
    await db.schema
      .createIndex("idx_video_recordings_owner_session")
      .on("video_recordings")
      .column("owner_session_uuid")
      .execute();

    await runMigrations(db, { provider: provider(), env: {} });

    const migration = await db
      .selectFrom("kysely_migration" as any)
      .select("name")
      .where("name", "=", MIGRATION_NAME)
      .executeTakeFirst();
    expect(migration?.name).toBe(MIGRATION_NAME);

    const columns = await sql<{ name: string }>`
      select name from pragma_table_info('video_recordings')
      where name = 'owner_session_uuid'
    `.execute(db);
    expect(columns.rows).toHaveLength(1);

    const index = await sql<{ name: string }>`
      select name from sqlite_master
      where type = 'index' and name = 'idx_video_recordings_owner_session'
    `.execute(db);
    expect(index.rows).toHaveLength(1);
  });

  test("creates the column and index on a fresh schema", async () => {
    await db.schema
      .createTable("video_recordings")
      .addColumn("id", "integer", column => column.primaryKey())
      .execute();

    await runMigrations(db, { provider: provider(), env: {} });

    const columns = await sql<{ name: string }>`
      select name from pragma_table_info('video_recordings')
      where name = 'owner_session_uuid'
    `.execute(db);
    expect(columns.rows).toHaveLength(1);

    const index = await sql<{ name: string }>`
      select name from sqlite_master
      where type = 'index' and name = 'idx_video_recordings_owner_session'
    `.execute(db);
    expect(index.rows).toHaveLength(1);
  });
});
