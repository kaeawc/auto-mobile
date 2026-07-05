import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { Kysely } from "kysely";
import { join } from "path";
import { tmpdir } from "os";
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });

  return { promise, resolve };
}

describe("configureSqliteDatabase", () => {
  test("enables WAL, busy timeout, and foreign keys for new connections", () => {
    const db = new FakeSqliteDatabase();

    configureSqliteDatabase(db);

    expect(db.statements).toEqual([
      `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`,
      "PRAGMA journal_mode = WAL;",
      "PRAGMA synchronous = NORMAL;",
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

  test("sets synchronous NORMAL after enabling WAL on Bun SQLite databases", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "auto-mobile-sqlite-"));
    const sqliteDb = new BunDatabase(join(tempDir, "test.db"));

    try {
      configureSqliteDatabase(sqliteDb);

      const journalMode = sqliteDb
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode;")
        .get();
      expect(journalMode?.journal_mode).toBe("wal");

      const synchronous = sqliteDb
        .query<{ synchronous: number }, []>("PRAGMA synchronous;")
        .get();
      expect(synchronous?.synchronous).toBe(1);
    } finally {
      sqliteDb.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("BunSqliteDialect transactions", () => {
  test("defers opening a lazy database until beforeQuery resolves", async () => {
    const releaseQuery = createDeferred();
    let databaseOpened = false;

    const db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({
        database: () => {
          databaseOpened = true;
          return new BunDatabase(":memory:");
        },
        beforeQuery: async () => {
          await releaseQuery.promise;
        },
      }),
    });

    try {
      const query = db
        .selectFrom("sqlite_master" as any)
        .selectAll()
        .execute();

      await Promise.resolve();
      expect(databaseOpened).toBe(false);

      releaseQuery.resolve();
      await query;
      expect(databaseOpened).toBe(true);
    } finally {
      await db.destroy();
    }
  });

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

  test("waits to run non-transaction queries while a transaction is open", async () => {
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

      const transactionStarted = createDeferred();
      const failTransaction = createDeferred();

      const transaction = db.transaction().execute(async trx => {
        await trx.insertInto("items").values({ id: 1, name: "rolled-back" }).execute();
        transactionStarted.resolve();
        await failTransaction.promise;
        throw new Error("force rollback");
      });

      await transactionStarted.promise;

      let outsideInsertFinished = false;
      const outsideInsert = db
        .insertInto("items")
        .values({ id: 2, name: "outside" })
        .execute()
        .then(() => {
          outsideInsertFinished = true;
        });

      await Promise.resolve();
      expect(outsideInsertFinished).toBe(false);

      failTransaction.resolve();
      await expect(transaction).rejects.toThrow("force rollback");
      await outsideInsert;

      const rows = await db.selectFrom("items").selectAll().orderBy("id").execute();
      expect(rows).toEqual([{ id: 2, name: "outside" }]);
    } finally {
      await db.destroy();
    }
  });

  test("prioritizes a pending transaction before later non-transaction queries", async () => {
    const heldQueryStarted = createDeferred();
    const releaseHeldQuery = createDeferred();
    const transactionStarted = createDeferred();
    const releaseTransaction = createDeferred();
    let holdNextQuery = false;

    const db = new Kysely<{ items: { id: number; name: string } }>({
      dialect: new BunSqliteDialect({
        database: new BunDatabase(":memory:"),
        beforeQuery: async () => {
          if (!holdNextQuery) {
            return;
          }

          holdNextQuery = false;
          heldQueryStarted.resolve();
          await releaseHeldQuery.promise;
        },
      }),
    });

    try {
      await db.schema
        .createTable("items")
        .addColumn("id", "integer", col => col.primaryKey())
        .addColumn("name", "text", col => col.notNull())
        .execute();

      holdNextQuery = true;
      const heldRead = db.selectFrom("items").selectAll().execute();
      await heldQueryStarted.promise;

      const transaction = db.transaction().execute(async trx => {
        await trx.insertInto("items").values({ id: 1, name: "transaction" }).execute();
        transactionStarted.resolve();
        await releaseTransaction.promise;
      });

      await Promise.resolve();

      let outsideInsertFinished = false;
      const outsideInsert = db
        .insertInto("items")
        .values({ id: 2, name: "outside" })
        .execute()
        .then(() => {
          outsideInsertFinished = true;
        });

      await Promise.resolve();
      expect(outsideInsertFinished).toBe(false);

      releaseHeldQuery.resolve();
      await heldRead;
      await transactionStarted.promise;
      expect(outsideInsertFinished).toBe(false);

      releaseTransaction.resolve();
      await transaction;
      await outsideInsert;

      const rows = await db.selectFrom("items").selectAll().orderBy("id").execute();
      expect(rows).toEqual([
        { id: 1, name: "transaction" },
        { id: 2, name: "outside" },
      ]);
    } finally {
      await db.destroy();
    }
  });
});
