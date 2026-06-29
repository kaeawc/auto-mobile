import { afterEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  configureSqliteDatabase,
  SQLITE_BUSY_TIMEOUT_MS,
} from "../../src/db/database";

class FakeSqliteDatabase {
  readonly statements: string[] = [];

  exec(sql: string): void {
    this.statements.push(sql);
  }
}

describe("configureSqliteDatabase", () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  test("enables WAL, busy timeout, and foreign keys for new connections", () => {
    const db = new FakeSqliteDatabase();

    configureSqliteDatabase(db);

    expect(db.statements).toEqual([
      `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`,
      "PRAGMA journal_mode = WAL;",
      "PRAGMA foreign_keys = ON;",
    ]);
  });

  test("sets a 5 second busy timeout on Bun SQLite file databases", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "auto-mobile-sqlite-"));
    tempDirs.push(tempDir);
    const sqliteDb = new BunDatabase(join(tempDir, "auto-mobile.db"));

    try {
      configureSqliteDatabase(sqliteDb);

      const result = sqliteDb
        .query<{ timeout: number }, []>("PRAGMA busy_timeout;")
        .get();
      expect(result?.timeout).toBe(5_000);
    } finally {
      sqliteDb.close();
    }
  });
});
