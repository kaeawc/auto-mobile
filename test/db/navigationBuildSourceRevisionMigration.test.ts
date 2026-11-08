import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { down, up } from "../../src/db/migrations/2026_11_07_000_navigation_build_source_revision";

describe("navigation build source revision migration (#16954)", () => {
  let bunDb: BunDatabase;
  let db: Kysely<unknown>;

  beforeEach(async () => {
    bunDb = new BunDatabase(":memory:");
    db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: bunDb }) });
    await sql`CREATE TABLE navigation_build_keys (
      id INTEGER PRIMARY KEY, app_id TEXT NOT NULL, version_code INTEGER NOT NULL,
      content_hash TEXT NOT NULL)`.execute(db);
    await sql`INSERT INTO navigation_build_keys (app_id, version_code, content_hash)
      VALUES ('com.app', 1, 'hash')`.execute(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  const columns = () =>
    (
      bunDb.query("SELECT name FROM pragma_table_info('navigation_build_keys')").all() as {
        name: string;
      }[]
    ).map((row) => row.name);

  test("up adds nullable git columns, leaving existing builds without a revision", async () => {
    await up(db);
    await up(db); // idempotent
    expect(columns()).toEqual([
      "id",
      "app_id",
      "version_code",
      "content_hash",
      "git_branch",
      "git_sha",
    ]);
    expect(bunDb.query("SELECT git_branch, git_sha FROM navigation_build_keys").all()).toEqual([
      { git_branch: null, git_sha: null },
    ]);
  });

  test("down drops the columns", async () => {
    await up(db);
    await down(db);
    expect(columns()).toEqual(["id", "app_id", "version_code", "content_hash"]);
  });
});
