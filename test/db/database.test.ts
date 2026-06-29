import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
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
  test("enables WAL, busy timeout, and foreign keys for new connections", () => {
    const db = new FakeSqliteDatabase();

    configureSqliteDatabase(db);

    expect(db.statements).toEqual([
      `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`,
      "PRAGMA journal_mode = WAL;",
      "PRAGMA foreign_keys = ON;",
    ]);
  });

  test("sets a 5 second busy timeout on Bun SQLite databases", async () => {
    const sqliteDb = new BunDatabase(":memory:");

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

describe("BunSqliteDialect transactions", () => {
  test("rolls back all statements when a transaction throws", async () => {
    const db = new Kysely<{ items: { id: number; name: string } }>({
      dialect: new BunSqliteDialect({
        database: new BunDatabase(":memory:"),
      }),
    });

    try {
      await db.schema
        .createTable("items")
        .addColumn("id", "integer", col => col.primaryKey())
        .addColumn("name", "text", col => col.notNull())
        .execute();

      await expect(
        db.transaction().execute(async trx => {
          await trx.insertInto("items").values({ id: 1, name: "rolled-back" }).execute();
          throw new Error("force rollback");
        })
      ).rejects.toThrow("force rollback");

      const rows = await db.selectFrom("items").selectAll().execute();
      expect(rows).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  test("commits all statements when a transaction completes", async () => {
    const db = new Kysely<{ items: { id: number; name: string } }>({
      dialect: new BunSqliteDialect({
        database: new BunDatabase(":memory:"),
      }),
    });

    try {
      await db.schema
        .createTable("items")
        .addColumn("id", "integer", col => col.primaryKey())
        .addColumn("name", "text", col => col.notNull())
        .execute();

      await db.transaction().execute(async trx => {
        await trx.insertInto("items").values({ id: 1, name: "committed" }).execute();
      });

      const rows = await db.selectFrom("items").selectAll().execute();
      expect(rows).toEqual([{ id: 1, name: "committed" }]);
    } finally {
      await db.destroy();
    }
  });
});
