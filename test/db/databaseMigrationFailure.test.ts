import { afterEach, describe, expect, test } from "bun:test";
import path from "path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { removeTempDbDir } from "./tempDbDir";

/**
 * Verifies the cached-error migration contract that issue #2784 depends on and
 * that #2786 (kill the floating rejection) shares:
 *
 *  - a startup migration failure is CACHED (`migrationsError`) and the internal
 *    `migrationsPromise` RESOLVES rather than floating a rejection, so nothing
 *    trips an `unhandledRejection` on the way to the fatal exit;
 *  - `ensureMigrations()` re-checks the cached error and RETHROWS after the await,
 *    so the fatality this issue relies on survives the resolved-promise model.
 *
 * A directory is used as the DB path so opening the sqlite file fails
 * deterministically (a permanent-style failure), exercised through a fresh module
 * instance so the module globals are isolated from other tests.
 */
describe("database startup migration failure contract", () => {
  const originalDbPath = process.env.AUTOMOBILE_DB_PATH;
  let tempDir: string | undefined;

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  afterEach(async () => {
    restore("AUTOMOBILE_DB_PATH", originalDbPath);
    if (tempDir) {
      await removeTempDbDir(tempDir);
      tempDir = undefined;
    }
  });

  async function importFreshDatabaseModule() {
    return import(`../../src/db/database.ts?migration-failure-test=${Date.now()}-${Math.random()}`);
  }

  test("ensureMigrations rethrows the cached startup error without floating a rejection", async () => {
    // Point the DB path at a directory so opening the sqlite file fails.
    tempDir = await mkdtemp(path.join(tmpdir(), "am-db-fail-"));
    process.env.AUTOMOBILE_DB_PATH = tempDir; // a directory, not a file

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const db = await importFreshDatabaseModule();

      await expect(db.ensureMigrations()).rejects.toThrow(
        /refusing to run queries until the daemon restarts/i
      );

      // The failure is cached and observable synchronously after the await.
      const cached = db.getMigrationsError();
      expect(cached).toBeInstanceOf(Error);
      expect(String(cached?.message)).toMatch(/refusing to run queries until the daemon restarts/i);

      // A second await still rejects (stable dead state, not auto-retried).
      await expect(db.ensureMigrations()).rejects.toThrow(
        /refusing to run queries until the daemon restarts/i
      );

      // Give any stray microtasks a tick to surface an unhandled rejection.
      await defaultTimer.sleep(10);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
