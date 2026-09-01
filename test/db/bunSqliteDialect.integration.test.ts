import { describe, it, expect, spyOn, test } from "bun:test";
import { CompiledQuery, Kysely, sql } from "kysely";
import { Database } from "bun:sqlite";
import { BunSqliteConnectionState, BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { ActionableError } from "../../src/models/ActionableError";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { logger } from "../../src/utils/logger";

/**
 * Regression for issue #2792: destroy() racing queries queued in Kysely's
 * ConnectionMutex must not leave any waiter permanently stranded.
 *
 * The interleaving is driven deterministically with a gated `beforeQuery` (a
 * deferred promise, NOT sleeps): the first query parks inside the mutex while two
 * more queue behind it, then `destroy()` fires. Kysely releases its
 * ConnectionMutex only when the driver's `acquireConnection` resolves — if the
 * dialect throws on acquire after close, the next waiter never settles (hang).
 */
describe("BunSqliteDialect destroy-during-queued-query (issue #2792)", () => {
  function gatedDialect(): {
    dialect: BunSqliteDialect;
    firstEntered: Promise<void>;
    release: () => void;
  } {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let signalEntered!: () => void;
    const firstEntered = new Promise<void>((r) => {
      signalEntered = r;
    });
    let count = 0;
    const beforeQuery = async (): Promise<void> => {
      count += 1;
      if (count === 1) {
        signalEntered();
        await gate; // park the first query while holding the mutex
      }
    };
    const memdb = new Database(":memory:");
    memdb.exec("CREATE TABLE t (id INTEGER)");
    const dialect = new BunSqliteDialect({ database: memdb, beforeQuery });
    return { dialect, firstEntered, release };
  }

  it("settles every queued query (none strand) when destroy races the queue", async () => {
    const { dialect, firstEntered, release } = gatedDialect();
    const db = new Kysely<any>({ dialect });

    const q1 = sql`SELECT 1 as v`.execute(db);
    await firstEntered; // Q1 now holds the ConnectionMutex

    const q2 = sql`SELECT 2 as v`.execute(db);
    const q3 = sql`SELECT 3 as v`.execute(db);
    // Let Q2/Q3 queue in Kysely's ConnectionMutex behind Q1.
    await Promise.resolve();
    await Promise.resolve();

    await db.destroy();
    release();

    // If any waiter strands, allSettled never resolves and the test times out.
    const results = await Promise.allSettled([q1, q2, q3]);
    expect(results).toHaveLength(3);
    // Every query must reach a terminal state — resolve or reject, never pending.
    for (const r of results) {
      expect(["fulfilled", "rejected"]).toContain(r.status);
    }
  });

  it("acquireConnection resolves after destroy and executeQuery rejects (no throw-on-acquire, no reopen)", async () => {
    // Exercise the driver directly: Kysely's RuntimeDriver rejects brand-new
    // queries at its own #destroyPromise guard, which would mask the dialect's
    // post-close behavior. The strand comes from the dialect THROWING on acquire,
    // so assert acquire resolves and the query rejects with a closed-db error.
    const memdb = new Database(":memory:");
    memdb.exec("CREATE TABLE t (id INTEGER)");
    const driver = new BunSqliteDialect({ database: memdb }).createDriver();
    await driver.init();

    const before = await driver.acquireConnection();
    await before.executeQuery(CompiledQuery.raw("SELECT 1")); // works before close
    await driver.releaseConnection(before);

    await driver.destroy();

    // Must NOT throw here — a throw is what strands the next Kysely mutex waiter.
    const after = await driver.acquireConnection();
    await expect(after.executeQuery(CompiledQuery.raw("SELECT 1"))).rejects.toThrow(
      /closed database/i,
    );
  });
});

/**
 * Fake bun:sqlite Database that records whether `.all` or `.run` was used for
 * the last prepared statement and lets a test inject a throwing statement. This
 * keeps the dialect tests off a real DB / wall-clock so they stay <100ms and
 * non-flaky (per CLAUDE.md).
 */
interface FakeRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

class FakeStatement {
  finalized = false;

  constructor(
    private readonly db: FakeDatabase,
    readonly sql: string,
  ) {}

  all(...params: unknown[]): unknown[] {
    if (this.finalized) {
      throw new Error(`Statement was finalized: ${this.sql}`);
    }
    this.db.record("all", this.sql, params);
    if (this.db.throwOn) {
      throw this.db.throwOn;
    }
    return this.db.rows;
  }

  get(...params: unknown[]): unknown {
    if (this.finalized) {
      throw new Error(`Statement was finalized: ${this.sql}`);
    }
    this.db.record("all", this.sql, params);
    if (this.db.throwOn) {
      throw this.db.throwOn;
    }
    if (this.sql === "PRAGMA schema_version") {
      return { schema_version: this.db.schemaVersion };
    }
    return this.db.rows[0];
  }

  run(...params: unknown[]): FakeRunResult {
    if (this.finalized) {
      throw new Error(`Statement was finalized: ${this.sql}`);
    }
    this.db.record("run", this.sql, params);
    if (this.db.throwOn) {
      throw this.db.throwOn;
    }
    return this.db.runResult;
  }

  finalize(): void {
    this.finalized = true;
  }
}

class FakeDatabase {
  readonly calls: Array<{ method: "all" | "run"; sql: string; params: unknown[] }> = [];
  readonly preparedStatements: FakeStatement[] = [];
  readonly prepareCalls: string[] = [];
  /** Ordered exec/close events so close-path ordering is assertable (#2802). */
  readonly lifecycleEvents: string[] = [];
  rows: unknown[] = [];
  runResult: FakeRunResult = { changes: 0, lastInsertRowid: 0 };
  schemaVersion = 1;
  throwOn?: unknown;
  throwOnExec?: unknown;
  readonly throwOnExecSql = new Map<string, unknown>();

  prepare(sql: string): FakeStatement {
    const statement = new FakeStatement(this, sql);
    this.preparedStatements.push(statement);
    this.prepareCalls.push(sql);
    return statement;
  }

  record(method: "all" | "run", sql: string, params: unknown[]): void {
    this.calls.push({ method, sql, params });
  }

  exec(sql: string): void {
    this.lifecycleEvents.push(`exec:${sql}`);
    const sqlError = this.throwOnExecSql.get(sql);
    if (sqlError) {
      throw sqlError;
    }
    if (this.throwOnExec) {
      throw this.throwOnExec;
    }
  }

  close(): void {
    this.lifecycleEvents.push("close");
  }

  get last(): { method: "all" | "run"; sql: string; params: unknown[] } | undefined {
    return this.calls[this.calls.length - 1];
  }

  preparedFor(sql: string): FakeStatement[] {
    return this.preparedStatements.filter((statement) => statement.sql === sql);
  }

  get applicationPrepareCalls(): string[] {
    return this.prepareCalls.filter((sql) => sql !== "PRAGMA schema_version");
  }

  get applicationCalls(): Array<{ method: "all" | "run"; sql: string; params: unknown[] }> {
    return this.calls.filter((call) => call.sql !== "PRAGMA schema_version");
  }
}

function makeState(db: FakeDatabase): BunSqliteConnectionState {
  return new BunSqliteConnectionState(db as unknown as never);
}

function rawQuery(sql: string, parameters: unknown[] = []): CompiledQuery {
  return { sql, parameters } as unknown as CompiledQuery;
}

/**
 * Reject rather than hang the whole suite if a fix regresses the nested-txn
 * guard back into a busy-loop (per the issue's acceptance criteria).
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let handle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = defaultTimer.setTimeout(
      () => reject(new Error(`TIMEOUT: call hung after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (handle) {
      defaultTimer.clearTimeout(handle);
    }
  }
}

describe("BunSqliteConnectionState — C4 nested-transaction guard", () => {
  test("a second beginTransaction on the same owner rejects with ActionableError instead of hanging", async () => {
    const db = new FakeDatabase();
    const state = makeState(db);
    const owner = Symbol("lease");

    await withTimeout(state.beginTransaction(owner), 1000);

    // Second begin on the SAME owner previously busy-looped forever in
    // #reserveTransaction (owner waiting for itself to release).
    await expect(withTimeout(state.beginTransaction(owner), 1000)).rejects.toBeInstanceOf(
      ActionableError,
    );
  });

  test("the guard does not break a fresh transaction from a different owner", async () => {
    const db = new FakeDatabase();
    const state = makeState(db);
    const owner1 = Symbol("lease-1");
    const owner2 = Symbol("lease-2");

    await withTimeout(state.beginTransaction(owner1), 1000);
    await withTimeout(state.commitTransaction(owner1), 1000);

    // A distinct lease must still be able to open a transaction.
    await expect(withTimeout(state.beginTransaction(owner2), 1000)).resolves.toBeUndefined();
  });

  test("the same lease can reopen a transaction after commit (guard only blocks re-entry)", async () => {
    const db = new FakeDatabase();
    const state = makeState(db);
    const owner = Symbol("lease");

    // commit clears #transactionOwner, so a fresh begin on the SAME owner is
    // NOT a nested re-entry and must be allowed (the guard is scoped to an
    // already-held lock, not to owner identity).
    await withTimeout(state.beginTransaction(owner), 1000);
    await withTimeout(state.commitTransaction(owner), 1000);
    await expect(withTimeout(state.beginTransaction(owner), 1000)).resolves.toBeUndefined();

    // Same for rollback.
    await withTimeout(state.rollbackTransaction(owner), 1000);
    await expect(withTimeout(state.beginTransaction(owner), 1000)).resolves.toBeUndefined();
  });
});

describe("BunSqliteConnectionState — prepared statement cache (#2797)", () => {
  test("reuses a cached statement for repeated identical SQL", async () => {
    const db = new FakeDatabase();
    const state = makeState(db);
    const owner = Symbol("lease");

    await state.executeQuery(rawQuery("insert into foo (id) values (?)", [1]), owner);
    await state.executeQuery(rawQuery("insert into foo (id) values (?)", [2]), owner);
    await state.executeQuery(rawQuery("insert into foo (id) values (?)", [3]), owner);

    expect(db.applicationPrepareCalls).toEqual(["insert into foo (id) values (?)"]);
    expect(db.applicationCalls.map((call) => call.params)).toEqual([[1], [2], [3]]);
  });

  test("keeps distinct SQL strings as distinct cache entries", async () => {
    const db = new FakeDatabase();
    const state = makeState(db);
    const owner = Symbol("lease");

    await state.executeQuery(rawQuery("insert into foo (id) values (?)", [1]), owner);
    await state.executeQuery(rawQuery("insert into foo (id, name) values (?, ?)", [2, "x"]), owner);
    await state.executeQuery(rawQuery("insert into foo (id) values (?)", [3]), owner);

    expect(db.applicationPrepareCalls).toEqual([
      "insert into foo (id) values (?)",
      "insert into foo (id, name) values (?, ?)",
    ]);
  });

  test("evicts and finalizes the least-recently-used statement when the cache is full", async () => {
    const db = new FakeDatabase();
    const state = makeState(db);
    const owner = Symbol("lease");

    await state.executeQuery(rawQuery("insert into foo_0 (id) values (?)", [0]), owner);
    for (let index = 1; index < 200; index += 1) {
      await state.executeQuery(
        rawQuery(`insert into foo_${index} (id) values (?)`, [index]),
        owner,
      );
    }

    const oldest = db.preparedFor("insert into foo_0 (id) values (?)")[0];
    const nextOldest = db.preparedFor("insert into foo_1 (id) values (?)")[0];

    await state.executeQuery(rawQuery("insert into foo_0 (id) values (?)", [999]), owner);
    await state.executeQuery(rawQuery("insert into foo_200 (id) values (?)", [200]), owner);

    expect(oldest.finalized).toBe(false);
    expect(nextOldest.finalized).toBe(true);
    expect(db.applicationPrepareCalls).toHaveLength(201);
    expect(
      db.preparedStatements.filter(
        (statement) => statement.sql !== "PRAGMA schema_version" && !statement.finalized,
      ),
    ).toHaveLength(200);
  });

  test("prepares a fresh statement after an evicted SQL is used again", async () => {
    const db = new FakeDatabase();
    const state = makeState(db);
    const owner = Symbol("lease");

    for (let index = 0; index < 201; index += 1) {
      await state.executeQuery(
        rawQuery(`insert into foo_${index} (id) values (?)`, [index]),
        owner,
      );
    }
    const evicted = db.preparedFor("insert into foo_0 (id) values (?)")[0];
    expect(evicted.finalized).toBe(true);

    await state.executeQuery(rawQuery("insert into foo_0 (id) values (?)", [999]), owner);

    expect(db.preparedFor("insert into foo_0 (id) values (?)")).toHaveLength(2);
    expect(db.preparedFor("insert into foo_0 (id) values (?)")[1].finalized).toBe(false);
  });

  test("finalizes all cached statements on close", async () => {
    const db = new FakeDatabase();
    const state = makeState(db);
    const owner = Symbol("lease");

    await state.executeQuery(rawQuery("select * from foo where id = ?", [1]), owner);
    await state.executeQuery(rawQuery("insert into foo (id) values (?)", [1]), owner);

    state.close();

    const applicationStatements = db.preparedStatements.filter(
      (statement) => statement.sql !== "PRAGMA schema_version",
    );
    expect(applicationStatements).toHaveLength(2);
    expect(applicationStatements.every((statement) => statement.finalized)).toBe(true);
  });

  test("clears cached statements after successful schema-changing SQL", async () => {
    const db = new FakeDatabase();
    const state = makeState(db);
    const owner = Symbol("lease");

    await state.executeQuery(rawQuery("select * from foo"), owner);
    const cachedSelect = db.preparedFor("select * from foo")[0];

    await state.executeQuery(rawQuery("alter table foo add column name text"), owner);
    const alterStatement = db.preparedFor("alter table foo add column name text")[0];

    expect(cachedSelect.finalized).toBe(true);
    expect(alterStatement.finalized).toBe(true);

    await state.executeQuery(rawQuery("select * from foo"), owner);

    expect(db.preparedFor("select * from foo")).toHaveLength(2);
    expect(db.preparedFor("select * from foo")[1].finalized).toBe(false);
  });

  test("clears cached statements after rollback", async () => {
    const db = new FakeDatabase();
    const state = makeState(db);
    const owner = Symbol("lease");

    await state.beginTransaction(owner);
    await state.executeQuery(rawQuery("select * from foo"), owner);
    const cachedSelect = db.preparedFor("select * from foo")[0];

    await state.rollbackTransaction(owner);
    const rollbackStatement = db.preparedFor("rollback")[0];

    expect(cachedSelect.finalized).toBe(true);
    expect(rollbackStatement.finalized).toBe(true);

    await state.executeQuery(rawQuery("select * from foo"), owner);

    expect(db.preparedFor("select * from foo")).toHaveLength(2);
    expect(db.preparedFor("select * from foo")[1].finalized).toBe(false);
  });

  test("clears cached statements before reuse when schema_version changes", async () => {
    const db = new FakeDatabase();
    const state = makeState(db);
    const owner = Symbol("lease");

    await state.executeQuery(rawQuery("select * from foo"), owner);
    const cachedSelect = db.preparedFor("select * from foo")[0];

    db.schemaVersion += 1;
    await state.executeQuery(rawQuery("select * from foo"), owner);

    expect(cachedSelect.finalized).toBe(true);
    expect(db.preparedFor("select * from foo")).toHaveLength(2);
    expect(db.preparedFor("select * from foo")[1].finalized).toBe(false);
  });

  test("preserves SELECT, RETURNING, and write result shapes", async () => {
    const db = new FakeDatabase();
    const state = makeState(db);
    const owner = Symbol("lease");

    db.rows = [{ id: 1 }, { id: 2 }];
    await expect(state.executeQuery(rawQuery("select * from foo"), owner)).resolves.toEqual({
      rows: [{ id: 1 }, { id: 2 }],
      numAffectedRows: undefined,
    });

    await expect(
      state.executeQuery(rawQuery("insert into foo (name) values (?) returning id", ["x"]), owner),
    ).resolves.toEqual({
      rows: [{ id: 1 }, { id: 2 }],
      numAffectedRows: 2n,
    });

    db.runResult = { changes: 3, lastInsertRowid: 42 };
    await expect(
      state.executeQuery(rawQuery("update foo set name = ? where id = ?", ["y", 1]), owner),
    ).resolves.toEqual({
      rows: [],
      numAffectedRows: 3n,
      insertId: 42n,
    });
  });
});

describe("BunSqliteConnectionState — C5 error wrapping", () => {
  test("preserves the original SqliteError as cause (by identity) with its code", async () => {
    const db = new FakeDatabase();
    const original = Object.assign(new Error("constraint failed"), {
      code: "SQLITE_CONSTRAINT",
    });
    db.throwOn = original;
    const state = makeState(db);
    const owner = Symbol("lease");

    let caught: unknown;
    try {
      await state.executeQuery(rawQuery("insert into foo (id) values (?)", [1]), owner);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    // Identity, not a stringified copy — describeUnknownError and any future
    // BUSY/constraint-retry path depend on reaching the real error object.
    expect((caught as Error).cause).toBe(original);
    expect(((caught as Error).cause as { code?: string }).code).toBe("SQLITE_CONSTRAINT");
  });

  test("does not throw a TypeError from JSON.stringify when a parameter is a BigInt", async () => {
    const db = new FakeDatabase();
    const original = new Error("boom");
    db.throwOn = original;
    const state = makeState(db);
    const owner = Symbol("lease");

    let caught: unknown;
    try {
      await state.executeQuery(rawQuery("insert into foo (n) values (?)", [123n]), owner);
    } catch (error) {
      caught = error;
    }

    // The reporter itself must not throw while serializing BigInt params.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("serialize a BigInt");
    expect((caught as Error).cause).toBe(original);
    // BigInt should be rendered as its string form in the diagnostic message.
    expect((caught as Error).message).toContain("123");
  });
});

describe("BunSqliteConnectionState — C6 word-boundary RETURNING detection", () => {
  test("an identifier containing 'returning' is NOT treated as a RETURNING clause", async () => {
    const db = new FakeDatabase();
    const state = makeState(db);
    const owner = Symbol("lease");

    // Only occurrence of 'returning' is the table name — must take the run() branch.
    await state.executeQuery(
      rawQuery("insert into returning_items (name) values (?)", ["x"]),
      owner,
    );

    expect(db.last?.method).toBe("run");
  });

  test("a real compiled Kysely .returning() query IS treated as row-returning", async () => {
    const db = new FakeDatabase();
    const kysely = new Kysely<{ foo: { id: number; name: string } }>({
      dialect: new BunSqliteDialect({ database: db as unknown as never }),
    });

    const compiled = kysely
      .insertInto("foo")
      .values({ id: 1, name: "x" })
      .returning("id")
      .compile();

    // Sanity: the compiled SQL is the real, lowercased-friendly RETURNING output.
    expect(compiled.sql.toLowerCase()).toContain(" returning ");

    const state = makeState(db);
    const owner = Symbol("lease");
    await state.executeQuery(compiled, owner);

    expect(db.last?.method).toBe("all");
  });
});

describe("BunSqliteConnectionState — close-time database maintenance", () => {
  test("issues PRAGMA optimize before the final wal_checkpoint(TRUNCATE)", () => {
    const db = new FakeDatabase();
    const state = makeState(db);

    state.close();

    expect(db.lifecycleEvents).toEqual([
      "exec:PRAGMA optimize;",
      "exec:PRAGMA wal_checkpoint(TRUNCATE);",
      "close",
    ]);
  });

  test("a failing checkpoint never blocks the close", () => {
    const db = new FakeDatabase();
    db.throwOnExecSql.set("PRAGMA wal_checkpoint(TRUNCATE);", new Error("database is locked"));
    const state = makeState(db);

    // Best-effort: the checkpoint error must be swallowed, not rethrown.
    expect(() => state.close()).not.toThrow();

    expect(db.lifecycleEvents).toEqual([
      "exec:PRAGMA optimize;",
      "exec:PRAGMA wal_checkpoint(TRUNCATE);",
      "close",
    ]);
  });

  test("a failing optimize never blocks the close", () => {
    const db = new FakeDatabase();
    db.throwOnExecSql.set("PRAGMA optimize;", new Error("optimize failed"));
    const state = makeState(db);
    const debugSpy = spyOn(logger, "debug");

    try {
      // Best-effort: optimize failures must be logged and swallowed, not rethrown.
      expect(() => state.close()).not.toThrow();
      expect(debugSpy).toHaveBeenCalledWith(
        "PRAGMA optimize on close failed: Error: optimize failed",
      );
    } finally {
      debugSpy.mockRestore();
    }

    expect(db.lifecycleEvents).toEqual([
      "exec:PRAGMA optimize;",
      "exec:PRAGMA wal_checkpoint(TRUNCATE);",
      "close",
    ]);
  });

  test("close is idempotent: maintenance and close run once", () => {
    const db = new FakeDatabase();
    const state = makeState(db);

    state.close();
    state.close();

    expect(db.lifecycleEvents).toEqual([
      "exec:PRAGMA optimize;",
      "exec:PRAGMA wal_checkpoint(TRUNCATE);",
      "close",
    ]);
  });

  test("does not open a lazily-unopened database just to run maintenance", () => {
    let opened = false;
    const state = new BunSqliteConnectionState(() => {
      opened = true;
      return new FakeDatabase() as unknown as never;
    });

    state.close();

    expect(opened).toBe(false);
  });
});
