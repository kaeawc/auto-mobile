import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, statSync } from "fs";
import { mkdtemp } from "fs/promises";
import { Kysely } from "kysely";
import { join } from "path";
import { tmpdir } from "os";
import { removeTempDbDir } from "./tempDbDir";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import {
  configureSqliteDatabase,
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_CACHE_SIZE_KIB,
  SQLITE_MMAP_SIZE_BYTES,
  SQLITE_TEMP_STORE,
  SQLITE_WAL_SIZE_LIMIT_BYTES,
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
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

describe("configureSqliteDatabase", () => {
  test("documents conservative read workload pragma sizes", () => {
    expect(SQLITE_CACHE_SIZE_KIB).toBe(16 * 1024);
    expect(SQLITE_MMAP_SIZE_BYTES).toBe(64 * 1024 * 1024);
    expect(SQLITE_TEMP_STORE).toBe("MEMORY");
  });

  test("enables WAL, busy timeout, read pragmas, WAL size limit, and foreign keys for new connections", () => {
    const db = new FakeSqliteDatabase();

    configureSqliteDatabase(db);

    expect(db.statements).toEqual([
      `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`,
      "PRAGMA journal_mode = WAL;",
      `PRAGMA journal_size_limit = ${SQLITE_WAL_SIZE_LIMIT_BYTES};`,
      `PRAGMA cache_size = -${SQLITE_CACHE_SIZE_KIB};`,
      `PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES};`,
      `PRAGMA temp_store = ${SQLITE_TEMP_STORE};`,
      "PRAGMA synchronous = NORMAL;",
      "PRAGMA foreign_keys = ON;",
    ]);
  });

  test("sets a 5 second busy timeout on Bun SQLite databases", async () => {
    const sqliteDb = new BunDatabase(":memory:");

    try {
      configureSqliteDatabase(sqliteDb);

      const result = sqliteDb.query<{ timeout: number }, []>("PRAGMA busy_timeout;").get();
      expect(result?.timeout).toBe(5_000);
    } finally {
      sqliteDb.close();
    }
  });

  test("sets synchronous NORMAL after enabling WAL on Bun SQLite databases", async () => {
    // WAL mode needs a real file (an in-memory DB reports journal_mode
    // "memory"), so this test uses a temp dir. Cleanup goes through the shared
    // bounded helper: bun:sqlite can briefly hold the `.db`/`-wal`/`-shm`
    // handles past close() on Windows, so a raw `rmSync` flakes with
    // EBUSY/EPERM/ENOTEMPTY (issues #2916/#3160).
    const tempDir = await mkdtemp(join(tmpdir(), "auto-mobile-sqlite-"));
    const sqliteDb = new BunDatabase(join(tempDir, "test.db"));

    try {
      configureSqliteDatabase(sqliteDb);

      const journalMode = sqliteDb
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode;")
        .get();
      expect(journalMode?.journal_mode).toBe("wal");

      const synchronous = sqliteDb.query<{ synchronous: number }, []>("PRAGMA synchronous;").get();
      expect(synchronous?.synchronous).toBe(1);
    } finally {
      sqliteDb.close();
      await removeTempDbDir(tempDir);
    }
  });

  test("caps the WAL size via journal_size_limit on Bun SQLite databases", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "auto-mobile-sqlite-"));
    const sqliteDb = new BunDatabase(join(tempDir, "test.db"));

    try {
      configureSqliteDatabase(sqliteDb);

      const limit = sqliteDb
        .query<{ journal_size_limit: number }, []>("PRAGMA journal_size_limit;")
        .get();
      expect(limit?.journal_size_limit).toBe(SQLITE_WAL_SIZE_LIMIT_BYTES);
    } finally {
      sqliteDb.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("sets read workload pragmas on Bun SQLite databases", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "auto-mobile-sqlite-"));
    const sqliteDb = new BunDatabase(join(tempDir, "test.db"));

    try {
      configureSqliteDatabase(sqliteDb);

      const cacheSize = sqliteDb.query<{ cache_size: number }, []>("PRAGMA cache_size;").get();
      expect(cacheSize?.cache_size).toBe(-SQLITE_CACHE_SIZE_KIB);

      const mmapSize = sqliteDb.query<{ mmap_size: number }, []>("PRAGMA mmap_size;").get();
      expect(mmapSize?.mmap_size).toBe(SQLITE_MMAP_SIZE_BYTES);

      const tempStore = sqliteDb.query<{ temp_store: number }, []>("PRAGMA temp_store;").get();
      expect(tempStore?.temp_store).toBe(2);
    } finally {
      sqliteDb.close();
      await removeTempDbDir(tempDir);
    }
  });
});

describe("WAL checkpoint on close (issue #2802)", () => {
  /** Size of the WAL sidecar, or 0 when SQLite already deleted it. */
  function walSize(dbPath: string): number {
    const walPath = `${dbPath}-wal`;
    return existsSync(walPath) ? statSync(walPath).size : 0;
  }

  test("wal_checkpoint(TRUNCATE) reports not-busy and truncates the WAL on the single owning connection", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "auto-mobile-sqlite-"));
    const dbPath = join(tempDir, "test.db");
    const sqliteDb = new BunDatabase(dbPath);

    try {
      configureSqliteDatabase(sqliteDb);
      sqliteDb.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");
      for (let i = 0; i < 50; i += 1) {
        sqliteDb.exec(`INSERT INTO items (name) VALUES ('row-${i}');`);
      }
      // The uncheckpointed writes must live in the WAL sidecar.
      expect(walSize(dbPath)).toBeGreaterThan(0);

      // `.query(...).get()` (not `.exec()`) so the `busy` flag is observable:
      // a busy checkpoint would silently skip truncation (issue #2802 review).
      const result = sqliteDb
        .query<{ busy: number; log: number; checkpointed: number }, []>(
          "PRAGMA wal_checkpoint(TRUNCATE);",
        )
        .get();
      expect(result?.busy).toBe(0);
      expect(result?.checkpointed).toBe(result?.log);

      expect(walSize(dbPath)).toBe(0);
    } finally {
      sqliteDb.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("a clean Kysely destroy leaves no WAL sidecar bytes behind", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "auto-mobile-sqlite-"));
    const dbPath = join(tempDir, "test.db");
    const sqliteDb = new BunDatabase(dbPath);
    configureSqliteDatabase(sqliteDb);

    const db = new Kysely<{ items: { id: number; name: string } }>({
      dialect: new BunSqliteDialect({ database: sqliteDb }),
    });

    try {
      await db.schema
        .createTable("items")
        .addColumn("id", "integer", (col) => col.primaryKey())
        .addColumn("name", "text", (col) => col.notNull())
        .execute();
      for (let i = 0; i < 50; i += 1) {
        await db
          .insertInto("items")
          .values({ id: i, name: `row-${i}` })
          .execute();
      }
      expect(walSize(dbPath)).toBeGreaterThan(0);

      // This is the same path `closeDatabase()` takes: Kysely destroy() ->
      // driver destroy() -> BunSqliteConnectionState.close() -> checkpoint.
      await db.destroy();

      expect(walSize(dbPath)).toBe(0);
    } finally {
      await db.destroy();
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
        .addColumn("id", "integer", (col) => col.primaryKey())
        .addColumn("name", "text", (col) => col.notNull())
        .execute();

      await expect(
        db.transaction().execute(async (trx) => {
          await trx.insertInto("items").values({ id: 1, name: "rolled-back" }).execute();
          throw new Error("force rollback");
        }),
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
        .addColumn("id", "integer", (col) => col.primaryKey())
        .addColumn("name", "text", (col) => col.notNull())
        .execute();

      await db.transaction().execute(async (trx) => {
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
        .addColumn("id", "integer", (col) => col.primaryKey())
        .addColumn("name", "text", (col) => col.notNull())
        .execute();

      const transactionStarted = createDeferred();
      const failTransaction = createDeferred();

      const transaction = db.transaction().execute(async (trx) => {
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
        .addColumn("id", "integer", (col) => col.primaryKey())
        .addColumn("name", "text", (col) => col.notNull())
        .execute();

      holdNextQuery = true;
      const heldRead = db.selectFrom("items").selectAll().execute();
      await heldQueryStarted.promise;

      const transaction = db.transaction().execute(async (trx) => {
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
