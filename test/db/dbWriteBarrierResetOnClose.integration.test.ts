import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "path";
import { existsSync } from "node:fs";
import { sql } from "kysely";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { getDbWriteBarrier, resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import {
  IN_MEMORY_DATABASE_PATH,
  IN_MEMORY_DB_OPT_IN_ENV,
  migrationLockPathFor,
} from "../../src/db/migrationLock";
import { importFreshDatabaseModule, restoreEnv, snapshotEnv } from "./freshDatabaseModule";
import { runExclusiveResetTest } from "./resetTestSerialLock";

/**
 * Regression tests for issue #2896 (follow-up to #2796), on a `:memory:`
 * sentinel DB (issue #3047).
 *
 * #2796 made `closeDatabase()` reset the migration/path module globals so a
 * same-process reopen behaves like a cold start. The one shutdown-state global
 * it deliberately left untouched was the {@link getDbWriteBarrier} drain latch:
 * once `beginDrain()`/`drain()` flips it, it stays draining for the process
 * lifetime and every tracked best-effort write short-circuits
 * (`dbWriteBarrier.ts` `track()`).
 *
 * The daemon quiesces in-flight writes by calling `getDbWriteBarrier().drain()`
 * BEFORE `closeDatabase()` (issue #2792 ordering). If any future path reopens
 * the DB in the same process after that drain (config reload, DB path switch,
 * restart-without-exit) without also cold-starting the barrier, the reopened DB
 * would silently skip every tracked best-effort write. `closeDatabase()` now
 * clears the barrier via `resetDbWriteBarrier()` so the cold-start contract holds
 * for consumers that resolve `getDbWriteBarrier()` at use-time. #2912 removed the
 * last exceptions: `TelemetryRecorder`, `FailureAnalyticsRepository` and
 * `SessionManager` were the three construction-captured consumers, and PR #2925
 * converted them to resolve per write, so every consumer now observes the identity
 * swap. `test/db/dbWriteBarrierReopenConsumers.integration.test.ts` is the
 * per-consumer proof.
 *
 * These assertions are about `getDbWriteBarrier()` **identity** and
 * `isDraining()` across the `getDatabase()`/`closeDatabase()` lifecycle — they
 * need neither a real on-disk file nor cross-connection migration visibility, so
 * a `:memory:` sentinel eliminates the temp-file / WAL-sidecar / EBUSY-cleanup
 * flake class this test formerly carried (issues #3047, #2992, #2916). The
 * sibling file-backed suites (`databaseReset`, `databaseLazyPath`) stay on real
 * files because they genuinely assert a migrated schema across connections.
 *
 * The shared barrier is a process-global singleton; `resetDbWriteBarrier()` in
 * `beforeEach`/`afterEach` isolates these tests from the rest of the suite.
 */
describe("closeDatabase cold-starts the dbWriteBarrier drain latch (issue #2896)", () => {
  let envSnapshot: NodeJS.ProcessEnv;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    // Start every test from a fresh, non-draining shared barrier so a latched
    // barrier leaked by another test cannot mask the reset under test.
    resetDbWriteBarrier();
  });

  afterEach(() => {
    resetDbWriteBarrier();
    restoreEnv(envSnapshot);
  });

  /** Point the fresh database module at a private in-memory sentinel DB. */
  function useInMemoryDatabase(): void {
    process.env.AUTOMOBILE_DB_PATH = IN_MEMORY_DATABASE_PATH;
    // `:memory:` is test-only and now runtime-guarded (issue #3065): a real
    // daemon that set it would fail fast. Lifecycle tests opt in explicitly.
    process.env[IN_MEMORY_DB_OPT_IN_ENV] = "1";
    delete process.env.AUTOMOBILE_DB_DIR;
    delete process.env[DAEMON_LAUNCH_CWD_ENV];
  }

  test("a tracked best-effort write after drain -> close -> reopen is NOT skipped", () =>
    runExclusiveResetTest(async () => {
      useInMemoryDatabase();

      const databaseModule = await importFreshDatabaseModule();

      // Cold start on the first in-memory DB. Await migrations so the detached
      // `:memory:` migration run is fully owned by the test rather than left in
      // flight past teardown — cheap on an in-memory DB (no file/WAL/lock) and
      // deterministic. The barrier assertions below need neither a real file nor a
      // completed migration (issue #3047); this is purely lifecycle hygiene.
      databaseModule.getDatabase();
      await databaseModule.ensureMigrations();

      // Model the daemon shutdown ordering: drain in-flight best-effort writes,
      // then close the connection (issue #2792).
      const shutdownBarrier = getDbWriteBarrier();
      expect(await shutdownBarrier.drain(1000)).toBe(true);
      expect(shutdownBarrier.isDraining()).toBe(true);

      await databaseModule.closeDatabase();

      // Reopen in the same process against a fresh in-memory DB (config reload / DB
      // path switch / restart-without-exit). Each `new Database(":memory:")` is a
      // brand-new private DB, so this naturally models a distinct reopened DB.
      databaseModule.getDatabase();
      await databaseModule.ensureMigrations();

      // The barrier must have cold-started: a distinct, non-draining instance.
      const reopenedBarrier = getDbWriteBarrier();
      expect(reopenedBarrier).not.toBe(shutdownBarrier);
      expect(reopenedBarrier.isDraining()).toBe(false);

      // The core contract: a tracked best-effort write actually runs against the
      // reopened barrier instead of being silently skipped by a latched barrier.
      let ran = false;
      const result = await reopenedBarrier.track(async () => {
        ran = true;
        return "ok";
      });
      expect(ran).toBe(true);
      expect(result).toBe("ok");

      await databaseModule.closeDatabase();
    }));

  test("reopens an in-memory DB with a live queryable connection and no bogus lock file", () =>
    runExclusiveResetTest(async () => {
      useInMemoryDatabase();

      const databaseModule = await importFreshDatabaseModule();

      // Drive the full open + migration lifecycle on `:memory:`. This reconciles the
      // reopen-query assertion added in #3040 for the file-backed test: with a
      // private in-memory DB the app connection never sees the migration
      // connection's schema, so instead of querying a migrated table we prove the
      // reopened connection is live with a schema-independent `select 1` that still
      // routes through `waitForMigrationsBeforeQuery` (proving migrations settle).
      databaseModule.getDatabase();
      await databaseModule.ensureMigrations();

      const rows = await sql`select 1 as one`.execute(databaseModule.getDatabase());
      expect(rows.rows).toEqual([{ one: 1 }]);

      // The blocker this migration fixes: a `:memory:` opener must use a
      // NoOpMigrationLock, never `createFileMigrationLock`, so it must not create a
      // bogus `:memory:.migrate.lock` file (nor a `:memory:` DB file) in the cwd.
      // Assert against the EXACT path the production lock would derive
      // (`migrationLockPathFor`) rather than a hand-rolled cwd join, so the guard
      // can't drift from the code under a symlinked / non-canonical cwd.
      expect(existsSync(migrationLockPathFor(IN_MEMORY_DATABASE_PATH))).toBe(false);
      expect(existsSync(path.join(process.cwd(), IN_MEMORY_DATABASE_PATH))).toBe(false);

      await databaseModule.closeDatabase();
    }));

  test("closeDatabase clears a drain latch even with no open connection", () =>
    runExclusiveResetTest(async () => {
      useInMemoryDatabase();

      const databaseModule = await importFreshDatabaseModule();

      // Latch the barrier without ever opening the DB, then close. The reset is
      // unconditional (mirrors the migration-global reset), so the latch clears
      // even on a partially-initialized shutdown.
      const latched = getDbWriteBarrier();
      latched.beginDrain();
      expect(latched.isDraining()).toBe(true);

      await databaseModule.closeDatabase();

      const fresh = getDbWriteBarrier();
      expect(fresh).not.toBe(latched);
      expect(fresh.isDraining()).toBe(false);
    }));

  test("getDatabase() fails fast when `:memory:` is set without the opt-in (issue #3065)", () =>
    runExclusiveResetTest(async () => {
      // A real daemon that set AUTOMOBILE_DB_PATH=:memory: without the test opt-in
      // must fail legibly at open time, not silently run against a
      // migrated-but-empty app connection. The guard lives at the single path-
      // resolution choke point, so getDatabase() surfaces it.
      process.env.AUTOMOBILE_DB_PATH = IN_MEMORY_DATABASE_PATH;
      delete process.env[IN_MEMORY_DB_OPT_IN_ENV];
      delete process.env.AUTOMOBILE_DB_DIR;
      delete process.env[DAEMON_LAUNCH_CWD_ENV];

      const databaseModule = await importFreshDatabaseModule();

      expect(() => databaseModule.getDatabase()).toThrow(/:memory:/);
    }));
});
