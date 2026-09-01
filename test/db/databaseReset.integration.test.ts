import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "path";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { createFileBackedDbHarness, WINDOWS_FILE_DB_TEST_TIMEOUT_MS } from "./withFileBackedDb";
import { runExclusiveResetTest } from "./resetTestSerialLock";

/**
 * Regression tests for issue #2796.
 *
 * `closeDatabase()` destroys the Kysely instance but historically left the
 * module-global migration state machine (`migrationsRun` / `migrationsPromise`
 * / `migrationsError`) and the cached `resolvedDbPath` set. A same-process
 * reopen therefore inherited stale state: `ensureMigrationsStarted()` no-ops
 * because `migrationsRun` is still true, `waitForMigrationsBeforeQuery()`
 * short-circuits, and the new connection issues queries against a possibly
 * unmigrated schema — or throws a stale cached startup error against an
 * otherwise-healthy new DB. The fix resets all four globals unconditionally so
 * a reopen behaves like a cold start.
 *
 * These globals are module-scoped and not exported, so each assertion drives
 * the reset through observable behavior (re-migration / re-resolution) rather
 * than reading internals directly.
 */
describe("closeDatabase resets migration + path globals (issue #2796)", () => {
  // Tests that genuinely open a real file-backed DB (migration/query paths use a
  // separate connection from the app connection, so they need a shared on-disk
  // file — `:memory:` gives each connection its own empty DB). This timeout only
  // covers the test BODY (migrations + queries on slow Windows disk I/O); it does
  // NOT govern the `afterEach` hook, which uses bun's default hook timeout
  // independently. The cleanup stall from issue #2916 is bounded separately by
  // `removeTempDbDir` (best-effort, ~200ms/dir), keeping afterEach well under the
  // hook timeout. Shares the one canonical file-backed ceiling (issue #2992).
  const FILE_BACKED_TEST_TIMEOUT_MS = WINDOWS_FILE_DB_TEST_TIMEOUT_MS;

  // Shared harness: fresh module import, tracked temp dirs cleaned with the
  // bounded `removeTempDbDir`, and full-env snapshot/restore (issue #3046). The
  // snapshot is taken per test (in `beforeEach`) so every mutated key is restored
  // regardless of which ones a given test touches.
  let harness = createFileBackedDbHarness();

  beforeEach(() => {
    harness = createFileBackedDbHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const makeTempDbDir = (prefix: string): Promise<string> => harness.makeTempDbDir(prefix);

  function queryToolCalls(db: any) {
    return db
      .selectFrom("tool_calls" as any)
      .selectAll()
      .execute();
  }

  test(
    "reopen after close re-runs migrations against a fresh DB (migrationsRun reset)",
    () =>
      runExclusiveResetTest(async () => {
        // Cold start on the first DB via the shared open helper — fresh module +
        // tracked temp dir + `getDatabase()` then awaited migrations (the #2992/#3040
        // ordering). Querying a migrated table proves migrations actually ran
        // (migrationsRun became true).
        const first = await harness.openLifecycleTestDb("auto-mobile-reset-first-");
        const databaseModule = first.module;
        expect(await queryToolCalls(databaseModule.getDatabase())).toEqual([]);

        await first.close();

        // Point at a brand-new, empty DB dir and reopen in the same process.
        const secondDir = await makeTempDbDir("auto-mobile-reset-second-");
        process.env.AUTOMOBILE_DB_DIR = secondDir;

        // The reopen must bind the fresh file (resolvedDbPath reset), otherwise the
        // stale path cache silently redirects back to the first (already-migrated)
        // DB and masks the migrationsRun bug below.
        expect(databaseModule.getDatabasePath()).toBe(path.join(secondDir, "auto-mobile.db"));

        // And against that fresh, empty file migrations must re-run (migrationsRun
        // reset). If they don't, ensureMigrationsStarted() no-ops and the query
        // hits an unmigrated schema -> "no such table: tool_calls".
        const secondDb = databaseModule.getDatabase();
        expect(await queryToolCalls(secondDb)).toEqual([]);

        await databaseModule.closeDatabase();
      }),
    FILE_BACKED_TEST_TIMEOUT_MS,
  );

  test("reopen after close re-resolves the DB path under a changed env (resolvedDbPath reset)", () =>
    runExclusiveResetTest(async () => {
      // This assertion is on the pure path-resolution cache (`resolvedDbPath`),
      // which `resolveDatabasePathFromEnvironment()` computes as a string without
      // touching the filesystem. Drive it through `getDatabasePath()` alone and
      // never open a real `auto-mobile.db`, so it carries no dependency on Windows
      // file-handle release (issue #2916). `closeDatabase()` resets the path cache
      // unconditionally — even with no open connection — so the reset is still
      // exercised here.
      const firstDir = await makeTempDbDir("auto-mobile-reset-path-first-");
      process.env.AUTOMOBILE_DB_DIR = firstDir;
      delete process.env[DAEMON_LAUNCH_CWD_ENV];

      const databaseModule = await harness.importFreshDatabaseModule();

      // Resolve once so resolvedDbPath is cached (no DB file opened).
      expect(databaseModule.getDatabasePath()).toBe(path.join(firstDir, "auto-mobile.db"));

      await databaseModule.closeDatabase();

      // A changed env after close must be re-read (cache cleared).
      const secondDir = await makeTempDbDir("auto-mobile-reset-path-second-");
      process.env.AUTOMOBILE_DB_DIR = secondDir;

      expect(databaseModule.getDatabasePath()).toBe(path.join(secondDir, "auto-mobile.db"));
    }));

  test(
    "reopen after a failed boot behaves like a cold start (migrationsError reset)",
    () =>
      runExclusiveResetTest(async () => {
        const failDir = await makeTempDbDir("auto-mobile-reset-fail-");
        process.env.AUTOMOBILE_DB_DIR = failDir;
        // Force a startup-migration failure: a migrations dir that does not exist.
        process.env.AUTOMOBILE_MIGRATIONS_DIR = path.join(failDir, "missing-migrations");
        delete process.env.AUTO_MOBILE_MIGRATIONS_DIR;
        delete process.env[DAEMON_LAUNCH_CWD_ENV];

        const databaseModule = await harness.importFreshDatabaseModule();

        const failingDb = databaseModule.getDatabase();
        await expect(queryToolCalls(failingDb)).rejects.toThrow(
          "Database startup migrations failed; refusing to run queries until the daemon restarts.",
        );
        expect(databaseModule.getMigrationsError()).not.toBeNull();

        await databaseModule.closeDatabase();

        // The cached error must not survive the close.
        expect(databaseModule.getMigrationsError()).toBeNull();

        // Reopen with a valid migrations dir + fresh DB: it must migrate cleanly and
        // NOT rethrow the stale error from the failed boot.
        const healthyDir = await makeTempDbDir("auto-mobile-reset-healthy-");
        process.env.AUTOMOBILE_DB_DIR = healthyDir;
        delete process.env.AUTOMOBILE_MIGRATIONS_DIR;

        const healthyDb = databaseModule.getDatabase();
        expect(await queryToolCalls(healthyDb)).toEqual([]);
        expect(databaseModule.getMigrationsError()).toBeNull();

        await databaseModule.closeDatabase();
      }),
    FILE_BACKED_TEST_TIMEOUT_MS,
  );
});
