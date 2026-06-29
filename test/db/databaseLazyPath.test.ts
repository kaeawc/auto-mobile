import { afterEach, describe, expect, test } from "bun:test";
import path from "path";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";

/**
 * Regression test for the module-load-time-vs-runtime path hazard.
 *
 * A directly launched daemon (--daemon-mode, not spawned by DaemonManager) only sets
 * AUTOMOBILE_DAEMON_LAUNCH_CWD and chdirs inside Daemon.start(), AFTER src/db/database.ts
 * has been imported. If DB_PATH were resolved at module load it would bind a relative
 * AUTOMOBILE_DB_DIR to the import-time cwd with the env unset. The fix resolves the path
 * lazily (on first getDatabasePath()/getDatabase() call), so it sees the launch cwd that
 * Daemon.start() records after import — matching migrator.ts's runtime resolution.
 */
describe("database path lazy resolution", () => {
  const originalLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];
  const originalDbDir = process.env.AUTOMOBILE_DB_DIR;

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  afterEach(() => {
    restore(DAEMON_LAUNCH_CWD_ENV, originalLaunchCwd);
    restore("AUTOMOBILE_DB_DIR", originalDbDir);
  });

  async function importFreshDatabaseModule() {
    // Fresh module instance so its lazy cache is not shared with other tests.
    return import(`../../src/db/database.ts?lazy-db-path-test=${Date.now()}-${Math.random()}`);
  }

  test("resolves relative AUTOMOBILE_DB_DIR against the launch cwd set AFTER import", async () => {
    const importTimeCwd = process.cwd();
    const launchCwd = path.resolve("/project/auto-mobile");

    // Simulate the direct-launch ordering: a relative DB dir is configured, but the
    // launch cwd env is NOT yet set when the module is imported.
    process.env.AUTOMOBILE_DB_DIR = ".automobile-db";
    delete process.env[DAEMON_LAUNCH_CWD_ENV];

    const databaseModule = await importFreshDatabaseModule();

    // Daemon.start() records the launch cwd only after import / before first use.
    process.env[DAEMON_LAUNCH_CWD_ENV] = launchCwd;

    const resolved = databaseModule.getDatabasePath();

    // Must follow the launch cwd, NOT the cwd that was current when the module loaded.
    expect(resolved).toBe(path.join(launchCwd, ".automobile-db", "auto-mobile.db"));
    expect(resolved.startsWith(importTimeCwd)).toBe(false);
  });

  test("caches the resolved path so it stays stable for the process lifetime", async () => {
    process.env.AUTOMOBILE_DB_DIR = ".automobile-db";
    delete process.env[DAEMON_LAUNCH_CWD_ENV];

    const databaseModule = await importFreshDatabaseModule();

    process.env[DAEMON_LAUNCH_CWD_ENV] = path.resolve("/project/auto-mobile");
    const first = databaseModule.getDatabasePath();

    // A later env change must not move the database the daemon already opened against.
    process.env[DAEMON_LAUNCH_CWD_ENV] = path.resolve("/elsewhere/launch-cwd");
    const second = databaseModule.getDatabasePath();

    expect(second).toBe(first);
  });
});
