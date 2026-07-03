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
 * the complementary "reset as a SET" assertion: after ONE successful boot +
 * close, a same-process reopen must cold-start on EVERY axis at once (path
 * re-resolved, migrations re-armed and re-run, no stale error). Any single field
 * left un-reset by a future `reset()` fails here even if the per-axis tests still
 * pass, because those axes interact — e.g. a stale `resolvedDbPath` masks a
 * `migrationsRun` bug by redirecting back to the already-migrated first DB.
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

  test("one successful boot + close makes the reopen a total cold start on every axis", async () => {
    const firstDir = await makeTempDbDir("auto-mobile-lifecycle-first-");
    process.env.AUTOMOBILE_DB_DIR = firstDir;
    delete process.env[DAEMON_LAUNCH_CWD_ENV];

    const databaseModule = await importFreshDatabaseModule();

    // Cold start on the first DB: path resolves + caches, migrations run,
    // migrationsRun/migrationsPromise settle, migrationsError stays null.
    const firstDb = databaseModule.getDatabase();
    expect(databaseModule.getDatabasePath()).toBe(path.join(firstDir, "auto-mobile.db"));
    expect(await queryToolCalls(firstDb)).toEqual([]);
    expect(databaseModule.getMigrationsError()).toBeNull();

    await databaseModule.closeDatabase();

    // Point at a brand-new, empty DB dir and reopen in the same process. A single
    // un-reset axis breaks this flow:
    //   - stale resolvedDbPath  -> path assertion below redirects to the old dir
    //   - stale migrationsRun   -> ensureMigrationsStarted() no-ops, query hits an
    //                              unmigrated schema ("no such table: tool_calls")
    //   - stale migrationsPromise -> ditto (re-arm is gated on it being null)
    //   - stale migrationsError -> a spurious cached error rethrows on query
    const secondDir = await makeTempDbDir("auto-mobile-lifecycle-second-");
    process.env.AUTOMOBILE_DB_DIR = secondDir;

    // resolvedDbPath reset: the reopen must bind the fresh file.
    expect(databaseModule.getDatabasePath()).toBe(path.join(secondDir, "auto-mobile.db"));

    // migrationsRun + migrationsPromise reset: migrations must re-run against the
    // fresh, empty file (query succeeds against a migrated schema).
    const secondDb = databaseModule.getDatabase();
    expect(await queryToolCalls(secondDb)).toEqual([]);

    // migrationsError reset: the healthy reopen carries no cached failure.
    expect(databaseModule.getMigrationsError()).toBeNull();

    await databaseModule.closeDatabase();
  });
});
