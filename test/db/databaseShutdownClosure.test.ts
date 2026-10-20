import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "kysely";
import {
  closeDatabase,
  ensureMigrations,
  getDatabase,
  getMigrationsPromiseForTest,
  refusedDatabaseAccessCountAfterShutdownClose,
} from "../../src/db/database";
import { DatabaseClosedForShutdownError } from "../../src/db/DatabaseClosedForShutdownError";
import { getDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import * as migratorModule from "../../src/db/migrator";
import { IN_MEMORY_DB_OPT_IN_ENV } from "../../src/db/migrationLock";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

// #11601 follow-up: `getDatabase()` opens lazily, so work that outlived graceful shutdown — an
// in-flight tool call, an abandoned stage's continuation, a late timer callback — reopened the
// database AFTER the shutdown stage had closed it: a fresh connection, a second migration run,
// and (file-backed) a new handle behind a process that is exiting. The write barrier does not
// stop it: the close swaps in a fresh, non-draining barrier.

const DB_ENV_KEYS = ["AUTOMOBILE_DB_PATH", "AUTOMOBILE_DB_DIR", IN_MEMORY_DB_OPT_IN_ENV] as const;

/** What a late writer does: resolve the singleton at use-time and write through the barrier. */
const lateWrite = (): Promise<unknown> =>
  getDbWriteBarrier().track(() => sql`create table late_write (x integer)`.execute(getDatabase()));

async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("no database reopen after the shutdown close (#11601)", () => {
  let savedEnv: Array<string | undefined>;
  let runMigrations: ReturnType<typeof spyOn>;
  let warn: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    savedEnv = DB_ENV_KEYS.map((key) => process.env[key]);
    process.env.AUTOMOBILE_DB_PATH = ":memory:";
    delete process.env.AUTOMOBILE_DB_DIR;
    process.env[IN_MEMORY_DB_OPT_IN_ENV] = "1";
    // The schema is not under test: an open that does reach the migrator must cost nothing.
    runMigrations = spyOn(migratorModule, "runMigrations").mockResolvedValue(undefined as never);
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    await closeDatabase();
  });

  afterEach(async () => {
    // The ordinary close is the reset: it lifts the shutdown closure for the next suite.
    await closeDatabase();
    warn.mockRestore();
    runMigrations.mockRestore();
    DB_ENV_KEYS.forEach((key, index) => {
      const value = savedEnv[index];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  test("an in-flight tool call's write after the close is refused, not run on a reopened connection", async () => {
    const before = getDatabase();
    await sql`create table kept (x integer)`.execute(before);
    await getDbWriteBarrier().drain(0);
    await closeDatabase({ forShutdown: true });
    runMigrations.mockClear();

    const error = await rejection(lateWrite());

    expect(error).toBeInstanceOf(DatabaseClosedForShutdownError);
    // Nothing was opened for it: no second migration run, no migration connection.
    expect(runMigrations).not.toHaveBeenCalled();
    expect(getMigrationsPromiseForTest()).toBeNull();
    expect(refusedDatabaseAccessCountAfterShutdownClose()).toBe(1);
    expect(warn.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      "[Database] Refused database access #1 after the shutdown close",
    ]);
    expect(warn.mock.calls[0]?.[1]).toBe(error);
  });

  test("a captured never-queried instance refuses a write after the shutdown close", async () => {
    const captured = getDatabase();
    await closeDatabase({ forShutdown: true });
    runMigrations.mockClear();

    const error = await rejection(sql`create table late_write (x integer)`.execute(captured));

    expect(error).toBeInstanceOf(DatabaseClosedForShutdownError);
    expect(refusedDatabaseAccessCountAfterShutdownClose()).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "[Database] Refused database access #1 after the shutdown close",
      error,
    );
    expect(runMigrations).not.toHaveBeenCalled();
    expect(getMigrationsPromiseForTest()).toBeNull();
  });

  test("a captured never-queried instance stays retired after an ordinary close and reopen", async () => {
    const captured = getDatabase();
    await closeDatabase();
    const fresh = getDatabase();

    const error = await rejection(sql`create table late_write (x integer)`.execute(captured));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Cannot use a closed database");
    await sql`create table reopened (x integer)`.execute(fresh);
    await sql`insert into reopened values (1)`.execute(fresh);
    expect((await sql<{ x: number }>`select x from reopened`.execute(fresh)).rows).toEqual([
      { x: 1 },
    ]);
    expect(refusedDatabaseAccessCountAfterShutdownClose()).toBe(0);
  });

  test.each([false, true])(
    "a captured queried instance rejects after close (forShutdown=%p)",
    async (forShutdown) => {
      const captured = getDatabase();
      await sql`create table kept (x integer)`.execute(captured);
      await closeDatabase({ forShutdown });

      expect(await rejection(sql`insert into kept values (1)`.execute(captured))).toBeInstanceOf(
        Error,
      );
    },
  );

  test.each([false, true])(
    "a captured never-queried instance refuses a transaction after close (forShutdown=%p)",
    async (forShutdown) => {
      const captured = getDatabase();
      await closeDatabase({ forShutdown });
      let bodyRan = false;

      const error = await rejection(
        captured.transaction().execute(async () => {
          bodyRan = true;
        }),
      );

      expect(error).toBeInstanceOf(Error);
      if (forShutdown) {
        expect(error).toBeInstanceOf(DatabaseClosedForShutdownError);
        expect(refusedDatabaseAccessCountAfterShutdownClose()).toBe(1);
      } else {
        expect((error as Error).message).toContain("Cannot use a closed database");
      }
      expect(bodyRan).toBe(false);
    },
  );

  test("a retired initialized instance counts shutdown refusals for writes and transactions", async () => {
    const captured = getDatabase();
    await sql`create table kept (x integer)`.execute(captured);
    await closeDatabase({ forShutdown: true });

    expect(await rejection(sql`insert into kept values (1)`.execute(captured))).toBeInstanceOf(
      DatabaseClosedForShutdownError,
    );
    let bodyRan = false;
    expect(
      await rejection(
        captured.transaction().execute(async () => {
          bodyRan = true;
        }),
      ),
    ).toBeInstanceOf(DatabaseClosedForShutdownError);
    expect(bodyRan).toBe(false);
    expect(refusedDatabaseAccessCountAfterShutdownClose()).toBe(2);
  });

  test("a timer callback that fires after the close is refused too, and each refusal is counted", async () => {
    const timer = new FakeTimer();
    const outcomes: Array<Promise<unknown>> = [];
    timer.setTimeout(() => outcomes.push(rejection(lateWrite())), 100);
    timer.setTimeout(() => outcomes.push(rejection(lateWrite())), 200);
    await closeDatabase({ forShutdown: true });

    timer.advanceTime(200);

    const errors = await Promise.all(outcomes);
    expect(errors.map((error) => error instanceof DatabaseClosedForShutdownError)).toEqual([
      true,
      true,
    ]);
    expect(refusedDatabaseAccessCountAfterShutdownClose()).toBe(2);
  });

  test("a late transaction is refused at its BEGIN and a late migration wait rejects", async () => {
    await closeDatabase({ forShutdown: true });
    let bodyRan = false;

    const transaction = await rejection(
      getDatabase()
        .transaction()
        .execute(async () => {
          bodyRan = true;
        }),
    );
    const migrations = await rejection(ensureMigrations());

    expect(transaction).toBeInstanceOf(DatabaseClosedForShutdownError);
    expect(migrations).toBeInstanceOf(DatabaseClosedForShutdownError);
    expect(bodyRan).toBe(false);
    expect(getMigrationsPromiseForTest()).toBeNull();
    expect(refusedDatabaseAccessCountAfterShutdownClose()).toBe(2);
  });

  test("only the first refusals are logged in full; the count keeps growing", async () => {
    await closeDatabase({ forShutdown: true });

    for (let attempt = 0; attempt < 7; attempt++) {
      await rejection(lateWrite());
    }

    expect(refusedDatabaseAccessCountAfterShutdownClose()).toBe(7);
    expect(warn).toHaveBeenCalledTimes(5);
  });

  test("a refused late write leaves no database file or directory behind", async () => {
    // Never created: the refusal happens before the lazy open that would mkdir and open it.
    const dbDir = path.join(tmpdir(), `auto-mobile-shutdown-closed-${process.pid}`, "never");
    delete process.env.AUTOMOBILE_DB_PATH;
    process.env.AUTOMOBILE_DB_DIR = dbDir;
    await closeDatabase({ forShutdown: true });

    const error = await rejection(lateWrite());

    expect(error).toBeInstanceOf(DatabaseClosedForShutdownError);
    expect(existsSync(dbDir)).toBe(false);
  });

  test("an ordinary close still reopens lazily, also after a shutdown close", async () => {
    const first = getDatabase();
    await closeDatabase();
    const second = getDatabase();
    await closeDatabase({ forShutdown: true });
    await closeDatabase();
    runMigrations.mockClear();

    const third = getDatabase();
    await sql`create table reopened (x integer)`.execute(third);
    await sql`insert into reopened values (1)`.execute(third);
    const rows = (await sql<{ x: number }>`select x from reopened`.execute(third)).rows;

    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
    expect(rows).toEqual([{ x: 1 }]);
    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(refusedDatabaseAccessCountAfterShutdownClose()).toBe(0);
  });
});
