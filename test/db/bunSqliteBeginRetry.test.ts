import { describe, expect, it } from "bun:test";
import type { Database as BunDatabase } from "bun:sqlite";
import { CompiledQuery } from "kysely";
import { BunSqliteConnectionState } from "../../src/db/bunSqliteDialect";
import { fixedBackoff } from "../../src/utils/Backoff";
import { FakeTimer } from "../fakes/FakeTimer";
import type { Random } from "../../src/utils/Random";

/**
 * `BEGIN IMMEDIATE` waits on the writer lock, so a `busy_timeout` expiry can
 * surface as SQLITE_BUSY at the BEGIN statement. The transaction owner is already
 * set by then (FIFO admission precedes the statement), which used to disable the
 * autocommit-only retry. BEGIN opens nothing when it fails, so it is always safe
 * to retry with the existing bounds, while statements INSIDE the transaction are
 * still never retried.
 */
class FakeSqliteError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SQLiteError";
  }
}

/** Scripted bun:sqlite fake: one outcome per statement execution, in order. */
function scriptedDatabase(outcomes: (FakeSqliteError | null | (() => FakeSqliteError))[]): {
  db: BunDatabase;
  executed: string[];
} {
  const executed: string[] = [];
  let calls = 0;
  const next = () => {
    const outcome = outcomes[calls++];
    if (outcome) {
      throw typeof outcome === "function" ? outcome() : outcome;
    }
  };
  const db = {
    prepare: (sql: string) => ({
      all: () => {
        executed.push(sql);
        next();
        return [];
      },
      run: () => {
        executed.push(sql);
        next();
        return { changes: 1, lastInsertRowid: 1 };
      },
      get: () => ({ schema_version: 0 }),
      finalize: () => {},
    }),
    exec: () => {},
    close: () => {},
  } as unknown as BunDatabase;
  return { db, executed };
}

const zeroRandom: Random = {
  next: () => 0,
  pick: <T>(items: readonly T[]): T => items[0]!,
};

const busy = () => new FakeSqliteError("database is locked", "SQLITE_BUSY");

function connection(db: BunDatabase, maxAttempts = 3, timer = new FakeTimer()) {
  timer.enableAutoAdvance();
  const state = new BunSqliteConnectionState(db, undefined, {
    maxAttempts,
    backoff: fixedBackoff(10),
    timer,
    random: zeroRandom,
  });
  return { state, timer };
}

describe("BunSqliteConnectionState BEGIN IMMEDIATE busy retry", () => {
  it("retries a BUSY at BEGIN and then opens the transaction", async () => {
    const { db, executed } = scriptedDatabase([busy(), busy(), null, null]);
    const { state, timer } = connection(db);
    const owner = Symbol("txn");

    await state.beginTransaction(owner);
    // The lease still owns the transaction: a statement and a commit go through.
    await state.executeQuery(CompiledQuery.raw("insert into t values (1)"), owner);
    await state.commitTransaction(owner);

    expect(executed.filter((sql) => /^begin/i.test(sql))).toHaveLength(3);
    expect(timer.getSleepHistory()).toHaveLength(2);
  });

  it("gives up after the existing attempt bound and releases the lock", async () => {
    const { db, executed } = scriptedDatabase([busy(), busy(), busy(), null]);
    const { state, timer } = connection(db);

    await expect(state.beginTransaction(Symbol("first"))).rejects.toThrow();
    expect(executed).toHaveLength(3);
    expect(timer.getSleepHistory()).toHaveLength(2);

    // The admission lock was released: another lease can begin.
    await state.beginTransaction(Symbol("second"));
    expect(executed).toHaveLength(4);
  });

  it("does not retry a non-BUSY BEGIN failure", async () => {
    const { db, executed } = scriptedDatabase([
      new FakeSqliteError("disk I/O error", "SQLITE_IOERR"),
    ]);
    const { state, timer } = connection(db);

    await expect(state.beginTransaction(Symbol("txn"))).rejects.toThrow();
    expect(executed).toHaveLength(1);
    expect(timer.getSleepHistory()).toHaveLength(0);
  });

  it("still never retries a statement inside the open transaction", async () => {
    const { db, executed } = scriptedDatabase([null, busy(), null]);
    const { state, timer } = connection(db);
    const owner = Symbol("txn");

    await state.beginTransaction(owner);
    await expect(
      state.executeQuery(CompiledQuery.raw("insert into t values (1)"), owner),
    ).rejects.toThrow();

    expect(executed).toHaveLength(2);
    expect(timer.getSleepHistory()).toHaveLength(0);
  });

  describe("total wait budget at BEGIN (#10134)", () => {
    /** A BUSY that took the connection's whole busy_timeout before failing. */
    const slowBusy = (timer: FakeTimer, waitedMs: number) => () => {
      timer.advanceTime(waitedMs);
      return busy();
    };

    it("does not retry once an attempt has already waited the full busy_timeout", async () => {
      const timer = new FakeTimer();
      const { db, executed } = scriptedDatabase([slowBusy(timer, 5_000), null]);
      const { state } = connection(db, 3, timer);

      await expect(state.beginTransaction(Symbol("slow"))).rejects.toThrow();

      expect(executed).toHaveLength(1);
      expect(timer.getSleepHistory()).toHaveLength(0);
    });

    it("keeps retrying fast BUSY failures while the budget remains", async () => {
      const timer = new FakeTimer();
      const { db, executed } = scriptedDatabase([
        slowBusy(timer, 1_000),
        slowBusy(timer, 1_000),
        null,
      ]);
      const { state } = connection(db, 3, timer);

      await state.beginTransaction(Symbol("quick"));

      expect(executed).toHaveLength(3);
    });

    it("stops after the attempt that crosses the budget even with attempts left", async () => {
      const timer = new FakeTimer();
      const { db, executed } = scriptedDatabase([
        slowBusy(timer, 2_000),
        slowBusy(timer, 3_100),
        null,
      ]);
      const { state } = connection(db, 5, timer);

      await expect(state.beginTransaction(Symbol("cross"))).rejects.toThrow();

      expect(executed).toHaveLength(2);
    });

    it("the budget is per BEGIN, so a later transaction starts with a full budget", async () => {
      const timer = new FakeTimer();
      const { db, executed } = scriptedDatabase([slowBusy(timer, 5_000), busy(), null]);
      const { state } = connection(db, 3, timer);

      await expect(state.beginTransaction(Symbol("first"))).rejects.toThrow();
      await state.beginTransaction(Symbol("second"));

      expect(executed).toHaveLength(3);
    });
  });
});
