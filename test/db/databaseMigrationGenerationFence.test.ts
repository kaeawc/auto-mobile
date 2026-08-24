import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "path";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { createFileBackedDbHarness } from "./withFileBackedDb";

/**
 * Regression tests for issue #2898 (follow-up to #2889 / #2796).
 *
 * `ensureMigrationsStarted()` builds `migrationsPromise` with `.then` handlers
 * that mutate the module globals `migrationsRun` / `migrationsError`. Nulling
 * those globals in `closeDatabase()` does NOT cancel the still-running detached
 * `startMigrations().then(...)` chain — it runs on its own `migrationDb` and
 * completes independently. If a `getDatabase()` reopen starts a NEW generation
 * of migration state before the old chain settles, the stale handler would
 * overwrite the new generation's `migrationsError`/`migrationsRun`.
 *
 * The fix captures a monotonic generation token when `migrationsPromise` is
 * created; both handlers no-op when their captured generation no longer matches
 * the current one (a `closeDatabase()` bumped it). These tests force a slow
 * migration, `closeDatabase()` mid-flight, reopen a fresh generation, then let
 * the stale completion fire and assert it cannot corrupt the new generation.
 *
 * The globals are module-scoped and not exported, so each assertion drives the
 * fence through observable behavior (`getMigrationsError()` / query gating)
 * rather than reading internals. A fresh module instance per case isolates the
 * lazy globals, matching databaseReset.test.ts / databaseMigrationFailure.test.ts.
 */
describe("closeDatabase fences stale in-flight migration completions (issue #2898)", () => {
  // Shared harness: fresh module import, tracked temp dirs cleaned with the
  // bounded `removeTempDbDir`, and full-env snapshot/restore (issue #3046).
  let harness = createFileBackedDbHarness();

  beforeEach(() => {
    harness = createFileBackedDbHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const makeTempDir = (prefix: string): Promise<string> => harness.makeTempDbDir(prefix);

  /**
   * A migrations dir with a single migration whose `up()` blocks until a
   * `release` marker appears, letting the test hold the migration "in flight"
   * across a `closeDatabase()`. It signals entry via a `started` marker and exit
   * via a `done` marker. In "fail" mode it throws after release; in "succeed"
   * mode it returns normally.
   */
  async function makeSlowMigrationsDir(
    mode: "fail" | "succeed",
    markers: { started: string; release: string },
  ): Promise<string> {
    const dir = await makeTempDir(`auto-mobile-gen-fence-mig-${mode}-`);
    const throwLine =
      mode === "fail"
        ? 'throw new Error("intentional slow migration failure (#2898 gen-fence test)");'
        : "";
    const content = `import { promises as fsp } from "fs";
import { existsSync } from "fs";

export async function up() {
  await fsp.writeFile(${JSON.stringify(markers.started)}, "1");
  for (let i = 0; i < 5000; i += 1) {
    if (existsSync(${JSON.stringify(markers.release)})) break;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  ${throwLine}
}

export async function down() {}
`;
    await writeFile(path.join(dir, "0001_slow_test_migration.ts"), content, "utf8");
    return dir;
  }

  /**
   * A migrations dir with one trivial, fast, always-succeeding migration. It
   * uses only the injected Kysely `db` (no bare `import`), so it resolves cleanly
   * even though the generated file lives in a temp dir with no node_modules.
   */
  async function makeHealthyMigrationsDir(): Promise<string> {
    const dir = await makeTempDir("auto-mobile-gen-fence-healthy-");
    const content = `export async function up(db) {
  await db.schema
    .createTable("gen_fence_probe")
    .ifNotExists()
    .addColumn("id", "integer", col => col.primaryKey())
    .execute();
}

export async function down(db) {
  await db.schema.dropTable("gen_fence_probe").ifExists().execute();
}
`;
    await writeFile(path.join(dir, "0001_healthy_test_migration.ts"), content, "utf8");
    return dir;
  }

  async function waitForMarker(marker: string, label: string): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (existsSync(marker)) {
        return;
      }
      await defaultTimer.sleep(2);
    }
    throw new Error(`Timed out waiting for ${label} marker: ${marker}`);
  }

  function markerPaths(root: string): { started: string; release: string } {
    return {
      started: path.join(root, "started"),
      release: path.join(root, "release"),
    };
  }

  test("stale FAILURE after close+reopen cannot set the new generation's migrationsError", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const markerRoot = await makeTempDir("auto-mobile-gen-fence-markers-");
      const markers = markerPaths(markerRoot);
      const slowFailDir = await makeSlowMigrationsDir("fail", markers);
      const dbDir1 = await makeTempDir("auto-mobile-gen-fence-db1-");

      setEnv(DAEMON_LAUNCH_CWD_ENV, undefined);
      setEnv("AUTOMOBILE_DB_PATH", undefined);
      setEnv("AUTO_MOBILE_DB_PATH", undefined);
      setEnv("AUTO_MOBILE_MIGRATIONS_DIR", undefined);
      setEnv("AUTOMOBILE_DB_DIR", dbDir1);
      setEnv("AUTOMOBILE_MIGRATIONS_DIR", slowFailDir);

      const db = await harness.importFreshDatabaseModule();

      // Generation 0: start the slow, will-fail migration and hold it in flight.
      db.getDatabase();
      await waitForMarker(markers.started, "generation-0 started");

      // Capture gen-0's resolve-never-reject `.then` chain while it is blocked so
      // we can deterministically await its completion later (the chain resolves
      // only after its stale handler runs) instead of racing a fixed delay.
      const staleCompletion = db.getMigrationsPromiseForTest() as Promise<void> | null;
      expect(staleCompletion).not.toBeNull();

      // Close mid-flight: resets globals + bumps the generation. The detached
      // gen-0 chain is still blocked on the release marker.
      await db.closeDatabase();

      // Generation 1: reopen against a fresh, healthy DB + migrations. It runs to
      // completion cleanly, so migrationsError must be null.
      const dbDir2 = await makeTempDir("auto-mobile-gen-fence-db2-");
      setEnv("AUTOMOBILE_DB_DIR", dbDir2);
      setEnv("AUTOMOBILE_MIGRATIONS_DIR", await makeHealthyMigrationsDir());

      db.getDatabase();
      await db.ensureMigrations();
      expect(db.getMigrationsError()).toBeNull();

      // Release the stale gen-0 migration so it proceeds and THROWS.
      await writeFile(markers.release, "1");

      // Deterministically await the detached gen-0 chain: it resolves (never
      // rejects) only after its `.then(onRejected)` handler has run. Without the
      // fence that handler would set migrationsError, corrupting the healthy
      // generation 1. Awaiting the promise removes any reliance on a fixed delay.
      await staleCompletion;

      expect(db.getMigrationsError()).toBeNull();

      await db.closeDatabase();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("stale SUCCESS after close+reopen cannot clear the new generation's cached error", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const markerRoot = await makeTempDir("auto-mobile-gen-fence-markers2-");
      const markers = markerPaths(markerRoot);
      const slowSucceedDir = await makeSlowMigrationsDir("succeed", markers);
      const dbDir1 = await makeTempDir("auto-mobile-gen-fence-db1s-");

      setEnv(DAEMON_LAUNCH_CWD_ENV, undefined);
      setEnv("AUTOMOBILE_DB_PATH", undefined);
      setEnv("AUTO_MOBILE_DB_PATH", undefined);
      setEnv("AUTO_MOBILE_MIGRATIONS_DIR", undefined);
      setEnv("AUTOMOBILE_DB_DIR", dbDir1);
      setEnv("AUTOMOBILE_MIGRATIONS_DIR", slowSucceedDir);

      const db = await harness.importFreshDatabaseModule();

      // Generation 0: start the slow, will-succeed migration and hold it.
      db.getDatabase();
      await waitForMarker(markers.started, "generation-0 started");

      const staleCompletion = db.getMigrationsPromiseForTest() as Promise<void> | null;
      expect(staleCompletion).not.toBeNull();

      await db.closeDatabase();

      // Generation 1: reopen against a path that fails to open (a directory), so
      // this generation caches a startup-migration error.
      const failDir = await makeTempDir("auto-mobile-gen-fence-faildir-");
      setEnv("AUTOMOBILE_DB_PATH", failDir); // a directory, not a file
      setEnv("AUTOMOBILE_DB_DIR", undefined);

      db.getDatabase();
      await expect(db.ensureMigrations()).rejects.toThrow(
        /refusing to run queries until the daemon restarts/i,
      );
      expect(db.getMigrationsError()).not.toBeNull();

      // Release the stale gen-0 migration so it SUCCEEDS.
      await writeFile(markers.release, "1");

      // Deterministically await the detached gen-0 chain (resolves only after its
      // `.then(onFulfilled)` handler runs). Without the fence that handler would
      // set migrationsRun=true and clear migrationsError, wrongly reviving a
      // generation whose boot actually failed.
      await staleCompletion;

      expect(db.getMigrationsError()).not.toBeNull();
      // The new generation is still query-dead — a stale success did not revive it.
      await expect(db.ensureMigrations()).rejects.toThrow(
        /refusing to run queries until the daemon restarts/i,
      );

      await db.closeDatabase();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("stale FAILURE cannot corrupt a SAME-DB-PATH reopen's generation (default reopen axis)", async () => {
    // The two tests above switch the DB directory between generations, so they
    // never exercise the default close+reopen case where the environment is
    // unchanged and both generations target the SAME database file. Here gen-0
    // and gen-1 use the same `AUTOMOBILE_DB_DIR` (identical DB path), only the
    // migrations dir differs, so the fence is proven on the same-file axis.
    //
    // NOTE — with issue #2947 fixed, gen-1 no longer STEALS gen-0's still-held
    // own-PID migrate lock: the per-process owner token marks it as a live
    // in-flight run, so gen-1 WAITS for gen-0 to release before migrating. This
    // test therefore kicks gen-1's migrations off without awaiting, releases gen-0
    // (which throws and frees the lock), and only then awaits gen-1 — otherwise
    // awaiting gen-1 first would deadlock on the lock gen-0 still holds. The fence
    // proof is unchanged: gen-0's stale FAILURE completion must not corrupt gen-1's
    // globals. The dedicated lock-safety proof (a gen-0 migration that WRITES) lives
    // in databaseMigrationLockReopen.test.ts.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const markerRoot = await makeTempDir("auto-mobile-gen-fence-markers3-");
      const markers = markerPaths(markerRoot);
      const slowFailDir = await makeSlowMigrationsDir("fail", markers);
      // One DB dir shared by BOTH generations -> the same DB file path on reopen.
      const sharedDbDir = await makeTempDir("auto-mobile-gen-fence-samepath-");

      setEnv(DAEMON_LAUNCH_CWD_ENV, undefined);
      setEnv("AUTOMOBILE_DB_PATH", undefined);
      setEnv("AUTO_MOBILE_DB_PATH", undefined);
      setEnv("AUTO_MOBILE_MIGRATIONS_DIR", undefined);
      setEnv("AUTOMOBILE_DB_DIR", sharedDbDir);
      setEnv("AUTOMOBILE_MIGRATIONS_DIR", slowFailDir);

      const db = await harness.importFreshDatabaseModule();

      // Generation 0: slow, will-fail migration on the shared DB path, held in flight.
      db.getDatabase();
      const gen0DbPath = db.getDatabasePath();
      await waitForMarker(markers.started, "generation-0 started");

      const staleCompletion = db.getMigrationsPromiseForTest() as Promise<void> | null;
      expect(staleCompletion).not.toBeNull();

      await db.closeDatabase();

      // Generation 1: reopen at the SAME DB path (env unchanged except a healthy
      // migrations dir). gen-0 still holds the migrate lock, so gen-1 must WAIT for
      // it (#2947) — kick migrations off WITHOUT awaiting.
      setEnv("AUTOMOBILE_MIGRATIONS_DIR", await makeHealthyMigrationsDir());

      db.getDatabase();
      expect(db.getDatabasePath()).toBe(gen0DbPath); // same file across generations
      const gen1 = db.ensureMigrations() as Promise<void>;

      // Release the stale gen-0 migration so it throws and frees the lock; gen-1
      // then acquires it and migrates cleanly, so migrationsError must be null.
      await writeFile(markers.release, "1");
      await gen1;
      expect(db.getMigrationsError()).toBeNull();

      // Await gen-0's detached (superseded) chain deterministically. Its stale
      // FAILURE handler must no-op under the fence and leave gen-1's clean state.
      await staleCompletion;
      expect(db.getMigrationsError()).toBeNull();

      await db.closeDatabase();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
