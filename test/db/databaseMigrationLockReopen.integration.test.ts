import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "path";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { createFileBackedDbHarness } from "./withFileBackedDb";

/**
 * Regression test for issue #2947 (sibling of the #2898 generation fence).
 *
 * `FileMigrationLock` reclaims a lock file bearing our OWN pid immediately
 * (`reclaimOwnPid: true`) on the assumption that "the migration run is a
 * per-process singleton", so a same-pid lock can only be a stale leak from a
 * crashed prior incarnation. An in-process SAME-PATH reopen while the previous
 * generation's migration is still IN FLIGHT breaks that assumption: gen-0 still
 * holds `${dbPath}.migrate.lock` (owner = our pid) and gen-1 would steal it, so
 * two migrators could enter `migrateToLatest()` on the same DB file — the exact
 * `kysely_migration` PRIMARY KEY collision the lock exists to prevent (#2794).
 *
 * The generation fence (#2898) only protects the module globals; it does NOT
 * serialize the on-disk migration runs. The fix tags the lock with a
 * per-process-instance token: a same-pid lock bearing OUR token is a live
 * in-flight run to WAIT for, while a different (or absent) token is the genuine
 * recycled-pid leak to reclaim.
 *
 * Unlike `databaseMigrationGenerationFence.integration.test.ts` (whose gen-0 migration throws
 * WITHOUT writing, so a stolen-lock concurrent run is benign), this gen-0
 * migration WRITES to the shared DB file, so a stolen lock would corrupt it.
 * A fresh module instance per case isolates the lazy globals.
 */
describe("in-process same-path reopen cannot steal an in-flight migration's lock (issue #2947)", () => {
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
   * A migrations dir with one migration that WRITES to the DB (creates `probe`
   * and inserts row id=1) BEFORE blocking on a `release` marker, holding the
   * migration — and its `${dbPath}.migrate.lock` — in flight across a
   * `closeDatabase()`. `probe`'s single-row PRIMARY KEY makes a concurrent second
   * migrator's re-insert collide, so a stolen lock corrupts observably.
   */
  async function makeSlowWritingMigrationsDir(markers: {
    started: string;
    release: string;
    active: string;
    violation: string;
  }): Promise<string> {
    const dir = await makeTempDir("auto-mobile-lock-reopen-mig-");
    const content = `import { promises as fsp } from "fs";
import { existsSync, openSync, closeSync, unlinkSync } from "fs";

export async function up(db) {
  // Timing-INDEPENDENT concurrency probe: hold an exclusive "migration active"
  // marker for the whole run via an O_EXCL ('wx') create. A second migrator that
  // stole the lock (#2947) and entered up() concurrently fails this create and
  // records a violation — detectable regardless of scheduling.
  try {
    closeSync(openSync(${JSON.stringify(markers.active)}, "wx"));
  } catch {
    await fsp.writeFile(${JSON.stringify(markers.violation)}, "1");
  }
  await db.schema
    .createTable("probe")
    .ifNotExists()
    .addColumn("id", "integer", col => col.primaryKey())
    .execute();
  await db.insertInto("probe").values({ id: 1 }).execute();
  await fsp.writeFile(${JSON.stringify(markers.started)}, "1");
  for (let i = 0; i < 5000; i += 1) {
    if (existsSync(${JSON.stringify(markers.release)})) break;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  try { unlinkSync(${JSON.stringify(markers.active)}); } catch {}
}

export async function down(db) {
  await db.schema.dropTable("probe").ifExists().execute();
}
`;
    await writeFile(path.join(dir, "0001_slow_writing_migration.ts"), content, "utf8");
    return dir;
  }

  async function waitForMarker(marker: string, label: string): Promise<void> {
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      if (existsSync(marker)) {
        return;
      }
      await defaultTimer.sleep(2);
    }
    throw new Error(`Timed out waiting for ${label} marker: ${marker}`);
  }

  test("gen-1 waits for the in-flight gen-0 migration instead of stealing its lock; no corruption", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const markerRoot = await makeTempDir("auto-mobile-lock-reopen-markers-");
      const markers = {
        started: path.join(markerRoot, "started"),
        release: path.join(markerRoot, "release"),
        active: path.join(markerRoot, "active"),
        violation: path.join(markerRoot, "violation"),
      };
      const migrationsDir = await makeSlowWritingMigrationsDir(markers);
      // One DB dir shared by BOTH generations -> the same DB file path on reopen.
      const sharedDbDir = await makeTempDir("auto-mobile-lock-reopen-db-");

      setEnv(DAEMON_LAUNCH_CWD_ENV, undefined);
      setEnv("AUTOMOBILE_DB_PATH", undefined);
      setEnv("AUTO_MOBILE_DB_PATH", undefined);
      setEnv("AUTO_MOBILE_MIGRATIONS_DIR", undefined);
      setEnv("AUTOMOBILE_DB_DIR", sharedDbDir);
      // Both generations use the SAME migrations dir + SAME DB path, the truest
      // concurrent-migration collision scenario.
      setEnv("AUTOMOBILE_MIGRATIONS_DIR", migrationsDir);

      const db = await harness.importFreshDatabaseModule();

      // Generation 0: start the slow, WRITING migration and hold it in flight
      // (mid-run, still holding the migrate lock).
      db.getDatabase();
      const gen0DbPath = db.getDatabasePath();
      await waitForMarker(markers.started, "generation-0 started");

      const staleCompletion = db.getMigrationsPromiseForTest() as Promise<void> | null;
      expect(staleCompletion).not.toBeNull();

      // Close mid-flight: nulls globals + bumps the generation. The detached gen-0
      // migration is still blocked on `release` and STILL HOLDS the migrate lock.
      await db.closeDatabase();

      // Generation 1: reopen at the SAME DB path, kick off migrations but do NOT
      // await yet.
      db.getDatabase();
      expect(db.getDatabasePath()).toBe(gen0DbPath);

      let gen1Settled = false;
      const gen1 = (db.ensureMigrations() as Promise<void>).then(
        () => {
          gen1Settled = true;
        },
        () => {
          gen1Settled = true;
        },
      );

      // No fixed wall-clock wait: this bounded loop early-exits the moment a
      // would-be lock thief manifests. On the pre-fix (stealing) code gen-1 enters
      // migrateToLatest() concurrently, so it settles and/or trips the exclusive
      // in-flight `active` marker (recording a `violation`) within a poll or two.
      // On the fixed code gen-1 stays parked on gen-0's still-held same-token lock
      // and produces NEITHER signal (gen-1 cannot settle until gen-0 releases,
      // which the test controls), so the loop runs its short bounded budget.
      for (let i = 0; i < 40 && !gen1Settled && !existsSync(markers.violation); i += 1) {
        await defaultTimer.sleep(5);
      }
      // Serialization proof: gen-1 has not run migrateToLatest() concurrently.
      expect(existsSync(markers.violation)).toBe(false);
      expect(gen1Settled).toBe(false);

      // Release gen-0: its migration finishes, records `0001`, and releases the
      // lock. gen-1 then acquires, sees `0001` already applied, and no-ops.
      await writeFile(markers.release, "1");
      await staleCompletion;
      await gen1;

      expect(gen1Settled).toBe(true);
      expect(existsSync(markers.violation)).toBe(false);
      expect(db.getMigrationsError()).toBeNull();

      // No corruption: the write ran exactly once (single `probe` row, single
      // `0001` history row) — a stolen concurrent run would have collided.
      const database = db.getDatabase();
      const probeRows = await database.selectFrom("probe").selectAll().execute();
      expect(probeRows).toHaveLength(1);
      const historyRows = await database.selectFrom("kysely_migration").select("name").execute();
      expect(historyRows.map((row: { name: string }) => row.name)).toEqual([
        "0001_slow_writing_migration",
      ]);

      await db.closeDatabase();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
