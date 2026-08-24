import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { existsSync, promises as fs, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { join } from "path";
import { Kysely } from "kysely";
import { Migrator, FileMigrationProvider } from "kysely/migration";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { runMigrations, resolveMigrationFolder } from "../../src/db/migrator";
import { FileMigrationLock, type MigrationLock } from "../../src/db/migrationLock";
import { FakeTimer } from "../fakes/FakeTimer";

// These tests exercise `runMigrations`'s interaction with a real
// `FileMigrationLock` (a temp lock file, opened/closed synchronously — no
// lingering handles, Windows-safe) while migrating an in-memory DB. A genuine
// cross-process PRIMARY-KEY collision can only be reproduced with two real OS
// processes; in-process the lock's guarantee is proven compositionally:
// - the primitive provides mutual exclusion (test/utils/fileLock.test.ts,
//   test/db/migrationLock.test.ts), and
// - `runMigrations` is gated by it (the serialization test below, which FAILS
//   if the lock is removed).

/** Records the acquire/release call order for ordering assertions. */
class RecordingMigrationLock implements MigrationLock {
  readonly calls: string[] = [];

  async acquire(): Promise<void> {
    this.calls.push("acquire");
  }

  async release(): Promise<void> {
    this.calls.push("release");
  }
}

function memoryDb(): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
  });
}

/**
 * Authoritative count of migrations Kysely will actually run, derived from the
 * provider rather than a raw file listing (a raw listing over-counts helpers and
 * `.d.ts`, and Kysely would then fail importing a non-migration file anyway).
 */
async function expectedMigrationCount(): Promise<number> {
  const probe = memoryDb();
  try {
    const migrator = new Migrator({
      db: probe,
      provider: new FileMigrationProvider({ fs, path, migrationFolder: resolveMigrationFolder() }),
    });
    return (await migrator.getMigrations()).length;
  } finally {
    await probe.destroy();
  }
}

/** A FileMigrationLock keyed to `lockPath`, acting as a distinct virtual opener. */
function opener(lockPath: string, pid: number, timeoutMs = 60_000): FileMigrationLock {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return new FileMigrationLock(lockPath, {
    timer,
    pid,
    pollIntervalMs: 5,
    timeoutMs,
    // Distinct virtual PIDs, all "alive" — the file lock is the only arbiter.
    isProcessRunning: (candidate) => candidate === 1 || candidate === 2,
  });
}

describe("runMigrations lock integration", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    process.env.AUTOMOBILE_MIGRATION_RECOVERY = "1";
    dir = mkdtempSync(join(tmpdir(), "migrator-lock-"));
    lockPath = join(dir, "auto-mobile.db.migrate.lock");
  });

  afterEach(() => {
    delete process.env.AUTOMOBILE_MIGRATION_RECOVERY;
    rmSync(dir, { recursive: true, force: true });
  });

  test("acquires the lock before migrating and releases it after", async () => {
    const db = memoryDb();
    const lock = new RecordingMigrationLock();

    await runMigrations(db, { lock });

    expect(lock.calls).toEqual(["acquire", "release"]);

    // Migrations actually ran between acquire and release.
    const rows = await db
      .selectFrom("kysely_migration" as any)
      .select("name")
      .execute();
    expect(rows.length).toBeGreaterThan(0);

    await db.destroy();
  });

  test("releases the lock even when migration fails", async () => {
    const db = memoryDb();
    const lock = new RecordingMigrationLock();
    // Point at a non-existent migrations folder so migrateToLatest fails.
    const previous = process.env.AUTOMOBILE_MIGRATIONS_DIR;
    process.env.AUTOMOBILE_MIGRATIONS_DIR = join(tmpdir(), "auto-mobile-does-not-exist-migrations");

    try {
      await expect(runMigrations(db, { lock })).rejects.toBeDefined();
    } finally {
      if (previous === undefined) {
        delete process.env.AUTOMOBILE_MIGRATIONS_DIR;
      } else {
        process.env.AUTOMOBILE_MIGRATIONS_DIR = previous;
      }
      await db.destroy();
    }

    expect(lock.calls).toEqual(["acquire", "release"]);
  });

  test("runMigrations WAITS on the lock while another opener holds it (lock is load-bearing)", async () => {
    // This is the test that proves the lock does something. If the lock were
    // removed (e.g. swapped for NoOpMigrationLock), the second runMigrations would
    // NOT time out here — it would migrate immediately — so this test fails,
    // catching a neutered lock.
    const holder = opener(lockPath, 1);
    await holder.acquire(); // opener A holds the lock

    const db = memoryDb();
    try {
      // Opener B's migration must block on the lock; with a short ceiling it times
      // out rather than proceeding — proof it is gated by the lock.
      const lockB = opener(lockPath, 2, 50);
      await expect(runMigrations(db, { lock: lockB })).rejects.toThrow(/migration lock/);

      // Once A releases, B proceeds and migrates the DB exactly once (no
      // double-write / PRIMARY-KEY collision).
      await holder.release();
      await runMigrations(db, { lock: opener(lockPath, 2) });

      const rows = await db
        .selectFrom("kysely_migration" as any)
        .select("name")
        .execute();
      expect(rows.length).toBe(await expectedMigrationCount());
    } finally {
      await db.destroy();
    }

    // The lock file is released (unlinked) after a successful run.
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a second opener still migrates after the first opener fails mid-migration", async () => {
    const dbA = memoryDb();
    const dbB = memoryDb();
    const previous = process.env.AUTOMOBILE_MIGRATIONS_DIR;

    try {
      // Opener A acquires the real lock, then fails (bad migrations folder). Its
      // finally-release must free the lock so B is not wedged.
      process.env.AUTOMOBILE_MIGRATIONS_DIR = join(tmpdir(), "auto-mobile-missing-migrations");
      await expect(runMigrations(dbA, { lock: opener(lockPath, 1) })).rejects.toBeDefined();
      expect(existsSync(lockPath)).toBe(false); // A released the lock on failure

      // Restore the real migrations folder; B acquires cleanly and migrates.
      if (previous === undefined) {
        delete process.env.AUTOMOBILE_MIGRATIONS_DIR;
      } else {
        process.env.AUTOMOBILE_MIGRATIONS_DIR = previous;
      }
      await runMigrations(dbB, { lock: opener(lockPath, 2) });

      const rows = await dbB
        .selectFrom("kysely_migration" as any)
        .select("name")
        .execute();
      expect(rows.length).toBe(await expectedMigrationCount());
    } finally {
      if (previous === undefined) {
        delete process.env.AUTOMOBILE_MIGRATIONS_DIR;
      } else {
        process.env.AUTOMOBILE_MIGRATIONS_DIR = previous;
      }
      await dbA.destroy();
      await dbB.destroy();
    }
  });
});
