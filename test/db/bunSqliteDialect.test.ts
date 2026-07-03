import { describe, expect, test } from "bun:test";
import { CompiledQuery, Kysely } from "kysely";
import { BunSqliteConnectionState, BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { ActionableError } from "../../src/models/ActionableError";
import { defaultTimer } from "../../src/utils/SystemTimer";

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
  constructor(
    private readonly db: FakeDatabase,
    private readonly sql: string
  ) {}

  all(...params: unknown[]): unknown[] {
    this.db.record("all", this.sql, params);
    if (this.db.throwOn) {
      throw this.db.throwOn;
    }
    return this.db.rows;
  }

  run(...params: unknown[]): FakeRunResult {
    this.db.record("run", this.sql, params);
    if (this.db.throwOn) {
      throw this.db.throwOn;
    }
    return { changes: 0, lastInsertRowid: 0 };
  }
}

class FakeDatabase {
  readonly calls: Array<{ method: "all" | "run"; sql: string; params: unknown[] }> = [];
  rows: unknown[] = [];
  throwOn?: unknown;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  record(method: "all" | "run", sql: string, params: unknown[]): void {
    this.calls.push({ method, sql, params });
  }

  close(): void {
    // no-op
  }

  get last(): { method: "all" | "run"; sql: string; params: unknown[] } | undefined {
    return this.calls[this.calls.length - 1];
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
      ms
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
      ActionableError
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
    await state.executeQuery(rawQuery("insert into returning_items (name) values (?)", ["x"]), owner);

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
