import { afterEach, describe, expect, test } from "bun:test";
import path from "path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { defaultTimer } from "../../src/utils/SystemTimer";

/**
 * Structural guard for issue #2900.
 *
 * The migration/path lifecycle (`resolvedDbPath` + the `migrationsRun` /
 * `migrationsPromise` / `migrationsError` state machine) was collapsed from four
 * bare module globals into a single object whose one `reset()` clears the whole
 * set. The value of that consolidation is that the reset is total *by
 * construction*: a partial reset (forgetting one axis) is the exact regression
 * class #2796 fixed and #2900 wants to make structurally impossible.
 *
 * `databaseReset.test.ts` proves each axis resets in isolation. This file adds
 * the complementary "reset as a SET" assertion: a single failed-then-healthy
 * boot flow across ONE close must cold-start on EVERY axis at once (path
 * re-resolved, migrations re-armed and re-run, cached failure cleared). Dropping
 * ANY single field from `reset()` fails this test single-handedly — including
 * `migrationsError`, which only a FAILED first boot populates before the close
 * (a successful boot leaves it null, so the healthy-reopen assertion would pass
 * trivially and the axis would go un-proven). The axes also interact — a stale
 * `resolvedDbPath` masks a `migrationsRun` bug by redirecting back to the
 * already-migrated first DB — which is why asserting them together matters.
 *
 * The globals are module-scoped and not exported, so the reset is driven through
 * observable behavior against a fresh module instance rather than by reading
 * internals.
 */
describe("closeDatabase resets the migration/path lifecycle as one set (issue #2900)", () => {
  const originalLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];
  const originalDbDir = process.env.AUTOMOBILE_DB_DIR;
  const originalDbPath = process.env.AUTOMOBILE_DB_PATH;
  const originalMigrationsDir = process.env.AUTOMOBILE_MIGRATIONS_DIR;
  const originalLegacyMigrationsDir = process.env.AUTO_MOBILE_MIGRATIONS_DIR;

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const tempDirs: string[] = [];

  afterEach(async () => {
    restore(DAEMON_LAUNCH_CWD_ENV, originalLaunchCwd);
    restore("AUTOMOBILE_DB_DIR", originalDbDir);
    restore("AUTOMOBILE_DB_PATH", originalDbPath);
    restore("AUTOMOBILE_MIGRATIONS_DIR", originalMigrationsDir);
    restore("AUTO_MOBILE_MIGRATIONS_DIR", originalLegacyMigrationsDir);
    for (const dir of tempDirs.splice(0)) {
      await removeTempDirWithRetry(dir);
    }
  });

  async function importFreshDatabaseModule() {
    // Fresh module instance so its lazy globals are not shared with other tests.
    return import(`../../src/db/database.ts?lifecycle-reset-test=${Date.now()}-${Math.random()}`);
  }

  async function makeTempDbDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function removeTempDirWithRetry(dir: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") {
          throw error;
        }
        await defaultTimer.sleep(50);
      }
    }
    await rm(dir, { recursive: true, force: true });
  }

  function queryToolCalls(db: any) {
    return db
      .selectFrom("tool_calls" as any)
      .selectAll()
      .execute();
  }

  test("a FAILED boot + close makes the reopen a total cold start on every axis", async () => {
    // The first boot must FAIL so `migrationsError` is actually populated before
    // close. A successful first boot leaves migrationsError null, so the healthy
    // reopen's `getMigrationsError() === null` would pass trivially and a dropped
    // `migrationsError` reset would go undetected — the axis would be un-proven.
    // Booting failed-then-healthy exercises all four axes in one flow so a
    // partial `reset()` that skips ANY single field fails here.
    const failDir = await makeTempDbDir("auto-mobile-lifecycle-fail-");
    process.env.AUTOMOBILE_DB_DIR = failDir;
    // Force a startup-migration failure: a migrations dir that does not exist.
    process.env.AUTOMOBILE_MIGRATIONS_DIR = path.join(failDir, "missing-migrations");
    delete process.env.AUTO_MOBILE_MIGRATIONS_DIR;
    delete process.env[DAEMON_LAUNCH_CWD_ENV];

    const databaseModule = await importFreshDatabaseModule();

    // Cold start on the first DB: path resolves + caches, migrations START and
    // FAIL, so migrationsPromise settles and migrationsError is cached non-null.
    const failingDb = databaseModule.getDatabase();
    expect(databaseModule.getDatabasePath()).toBe(path.join(failDir, "auto-mobile.db"));
    await expect(queryToolCalls(failingDb)).rejects.toThrow(
      "Database startup migrations failed; refusing to run queries until the daemon restarts."
    );
    // Precondition for the migrationsError axis: the error is really set before close.
    expect(databaseModule.getMigrationsError()).not.toBeNull();

    await databaseModule.closeDatabase();

    // Point at a brand-new, empty DB dir with a VALID migrations dir and reopen in
    // the same process. A single un-reset axis breaks this flow:
    //   - stale resolvedDbPath  -> path assertion below redirects to the old dir
    //   - stale migrationsRun   -> ensureMigrationsStarted() no-ops, query hits an
    //                              unmigrated schema ("no such table: tool_calls")
    //   - stale migrationsPromise -> ditto (re-arm is gated on it being null)
    //   - stale migrationsError -> the cached failed-boot error rethrows on query
    //                              against the otherwise-healthy reopened DB
    const healthyDir = await makeTempDbDir("auto-mobile-lifecycle-healthy-");
    process.env.AUTOMOBILE_DB_DIR = healthyDir;
    delete process.env.AUTOMOBILE_MIGRATIONS_DIR;

    // resolvedDbPath reset: the reopen must bind the fresh file.
    expect(databaseModule.getDatabasePath()).toBe(path.join(healthyDir, "auto-mobile.db"));

    // migrationsError reset: the cached failed-boot error must not survive close.
    expect(databaseModule.getMigrationsError()).toBeNull();

    // migrationsRun + migrationsPromise + migrationsError reset: migrations must
    // re-run against the fresh file and the query must succeed (not rethrow the
    // stale error) against a migrated schema.
    const healthyDb = databaseModule.getDatabase();
    expect(await queryToolCalls(healthyDb)).toEqual([]);
    expect(databaseModule.getMigrationsError()).toBeNull();

    await databaseModule.closeDatabase();
  });
});
