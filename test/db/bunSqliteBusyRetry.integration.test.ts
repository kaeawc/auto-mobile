import { describe, it, expect } from "bun:test";
import type { Database as BunDatabase } from "bun:sqlite";
import { CompiledQuery } from "kysely";
import { BunSqliteConnectionState } from "../../src/db/bunSqliteDialect";
import { fixedBackoff } from "../../src/utils/Backoff";
import { FakeTimer } from "../fakes/FakeTimer";
import type { Random } from "../../src/utils/Random";

/**
 * Issue #2874: consume `err.cause.code` for a BUSY/constraint-aware SQLite
 * retry. These tests use a fake `bun:sqlite` Database that throws a fake
 * `SqliteError` carrying a `.code`, plus a `FakeTimer` and a deterministic
 * `Random`, so they stay <100ms and non-flaky and rely on the `.cause`
 * identity contract from #2793 (never `.message` scraping).
 */

// A fake SqliteError: only the `.code` matters for classification.
class FakeSqliteError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SQLiteError";
  }
}

interface StatementScript {
  // One entry per `run`/`all` call: either an error to throw or `null` to succeed.
  throws: (FakeSqliteError | null)[];
}

/**
 * Minimal fake of the bun:sqlite Database surface the dialect touches:
 * `prepare(sql)` -> statement with `all`/`run`/`get`/`finalize`, and `exec`.
 * The script drives what each prepared-statement invocation does.
 */
function fakeDatabase(script: StatementScript): {
  db: BunDatabase;
  invocations: () => number;
} {
  let calls = 0;
  const makeStatement = () => ({
    all: (..._params: unknown[]) => {
      const outcome = script.throws[calls++];
      if (outcome) {
        throw outcome;
      }
      return [{ v: 1 }];
    },
    run: (..._params: unknown[]) => {
      const outcome = script.throws[calls++];
      if (outcome) {
        throw outcome;
      }
      return { changes: 1, lastInsertRowid: 1 };
    },
    get: (..._params: unknown[]) => ({ schema_version: 0 }),
    finalize: () => {},
  });
  const db = {
    prepare: (_sql: string) => makeStatement(),
    exec: (_sql: string) => {},
    close: () => {},
  } as unknown as BunDatabase;
  return { db, invocations: () => calls };
}

const zeroRandom: Random = {
  next: () => 0,
  pick: <T>(items: readonly T[]): T => items[0]!,
};

const SELECT = CompiledQuery.raw("select 1 as v");
const INSERT = CompiledQuery.raw("insert into t (v) values (1)");

describe("BunSqliteConnectionState BUSY/constraint-aware retry (issue #2874)", () => {
  it("retries a SQLITE_BUSY error then succeeds, sleeping via the injected timer", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { db, invocations } = fakeDatabase({
      throws: [new FakeSqliteError("database is locked", "SQLITE_BUSY"), null],
    });
    const state = new BunSqliteConnectionState(db, undefined, {
      maxAttempts: 3,
      backoff: fixedBackoff(10),
      timer,
      random: zeroRandom,
    });

    const result = await state.executeQuery(SELECT, Symbol("owner"));

    expect(result.rows).toEqual([{ v: 1 }] as any);
    expect(invocations()).toBe(2); // one failure + one success
    expect(timer.getSleepHistory().length).toBe(1); // exactly one backoff sleep
  });

  it("retries SQLITE_LOCKED as well", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { db, invocations } = fakeDatabase({
      throws: [new FakeSqliteError("locked", "SQLITE_LOCKED"), null],
    });
    const state = new BunSqliteConnectionState(db, undefined, {
      maxAttempts: 3,
      backoff: fixedBackoff(10),
      timer,
      random: zeroRandom,
    });

    await state.executeQuery(SELECT, Symbol("owner"));
    expect(invocations()).toBe(2);
  });

  it("does NOT retry a SQLITE_CONSTRAINT error (surfaces immediately)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { db, invocations } = fakeDatabase({
      throws: [new FakeSqliteError("UNIQUE constraint failed", "SQLITE_CONSTRAINT_UNIQUE")],
    });
    const state = new BunSqliteConnectionState(db, undefined, {
      maxAttempts: 3,
      backoff: fixedBackoff(10),
      timer,
      random: zeroRandom,
    });

    const error = await state.executeQuery(INSERT, Symbol("owner")).then(
      () => {
        throw new Error("expected the constraint error to surface");
      },
      (e: unknown) => e,
    );
    expect(invocations()).toBe(1); // no retry
    expect(timer.getSleepHistory().length).toBe(0);
    // The original SqliteError is preserved by identity via `.cause` (#2793 /
    // bunSqliteDialect.ts:406), not reconstructed from the message text.
    const cause = (error as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(FakeSqliteError);
    expect((cause as FakeSqliteError).code).toBe("SQLITE_CONSTRAINT_UNIQUE");
  });

  it("relies on err.cause.code by identity, not message text", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    // Message says nothing about busy/locked; only the structured code marks it
    // retryable. If classification scraped `.message` this would not retry.
    const { db, invocations } = fakeDatabase({
      throws: [new FakeSqliteError("opaque failure", "SQLITE_BUSY_SNAPSHOT"), null],
    });
    const state = new BunSqliteConnectionState(db, undefined, {
      maxAttempts: 3,
      backoff: fixedBackoff(10),
      timer,
      random: zeroRandom,
    });

    await state.executeQuery(SELECT, Symbol("owner"));
    expect(invocations()).toBe(2);
  });

  it("bounds the retry budget: exhausts maxAttempts then throws the wrapped error", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const busy = new FakeSqliteError("database is locked", "SQLITE_BUSY");
    const { db, invocations } = fakeDatabase({ throws: [busy, busy, busy, busy, busy] });
    const state = new BunSqliteConnectionState(db, undefined, {
      maxAttempts: 3,
      backoff: fixedBackoff(10),
      timer,
      random: zeroRandom,
    });

    const error = await state.executeQuery(SELECT, Symbol("owner")).catch((e) => e as Error);
    expect(error).toBeInstanceOf(Error);
    // The #2793 cause-identity contract: the original SqliteError is reachable.
    expect((error as Error).cause).toBe(busy);
    expect(invocations()).toBe(3); // exactly maxAttempts
    expect(timer.getSleepHistory().length).toBe(2); // sleeps between the 3 attempts
  });

  it("does NOT retry while a transaction is open (autocommit only)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const owner = Symbol("txn-owner");
    // begin succeeds; the in-transaction statement throws BUSY and must NOT retry.
    const { db, invocations } = fakeDatabase({
      throws: [null, new FakeSqliteError("database is locked", "SQLITE_BUSY"), null],
    });
    const state = new BunSqliteConnectionState(db, undefined, {
      maxAttempts: 3,
      backoff: fixedBackoff(10),
      timer,
      random: zeroRandom,
    });

    await state.beginTransaction(owner); // sets #transactionOwner (1 invocation)
    await expect(state.executeQuery(INSERT, owner)).rejects.toThrow();
    // begin (1) + the single failing in-txn attempt (1) = 2; no retry attempt.
    expect(invocations()).toBe(2);
    expect(timer.getSleepHistory().length).toBe(0);
  });

  it("disables retry when maxAttempts <= 1", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { db, invocations } = fakeDatabase({
      throws: [new FakeSqliteError("database is locked", "SQLITE_BUSY"), null],
    });
    const state = new BunSqliteConnectionState(db, undefined, {
      maxAttempts: 1,
      backoff: fixedBackoff(10),
      timer,
      random: zeroRandom,
    });

    await expect(state.executeQuery(SELECT, Symbol("owner"))).rejects.toThrow();
    expect(invocations()).toBe(1);
  });
});
