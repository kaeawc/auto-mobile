import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { promises as fs, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { join } from "path";
import { Kysely } from "kysely";
import { Migrator, FileMigrationProvider } from "kysely/migration";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { runMigrations, resolveMigrationFolder } from "../../src/db/migrator";
import { FileMigrationLock, type MigrationLock } from "../../src/db/migrationLock";
import { FakeTimer } from "../fakes/FakeTimer";

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

/**
 * Authoritative count of migrations Kysely will actually run, derived from the
 * provider rather than a raw file listing (a raw listing over-counts helpers and
 * `.d.ts`, and Kysely would then fail importing a non-migration file anyway).
 */
async function expectedMigrationCount(): Promise<number> {
  const probe = new Kysely<unknown>({
    dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
  });
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

function openFileDb(dbPath: string): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new BunSqliteDialect({ database: new BunDatabase(dbPath) }),
  });
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
    isProcessRunning: candidate => candidate === 1 || candidate === 2,
  });
}

describe("runMigrations lock integration", () => {
  beforeEach(() => {
    process.env.AUTOMOBILE_MIGRATION_RECOVERY = "1";
  });

  afterEach(() => {
    delete process.env.AUTOMOBILE_MIGRATION_RECOVERY;
  });

  test("acquires the lock before migrating and releases it after", async () => {
    const db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
    const lock = new RecordingMigrationLock();

    await runMigrations(db, lock);

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
    const db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
    const lock = new RecordingMigrationLock();
    // Point at a non-existent migrations folder so migrateToLatest fails.
    const previous = process.env.AUTOMOBILE_MIGRATIONS_DIR;
    process.env.AUTOMOBILE_MIGRATIONS_DIR = join(
      tmpdir(),
      "auto-mobile-does-not-exist-migrations"
    );

    try {
      await expect(runMigrations(db, lock)).rejects.toBeDefined();
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
    // catching a neutered lock. (A plain two-openers-in-one-process race does not:
    // bun:sqlite serializes the I/O incidentally, hiding a missing lock.)
    const dir = mkdtempSync(join(tmpdir(), "migrator-serialize-"));
    const dbPath = join(dir, "auto-mobile.db");
    const lockPath = `${dbPath}.migrate.lock`;

    // Opener A takes and holds the lock (simulating an in-flight migration).
    const holder = opener(lockPath, 1);
    await holder.acquire();

    const db2 = openFileDb(dbPath);
    try {
      // Opener B's migration must block on the lock; with a short ceiling it times
      // out rather than proceeding — proof it is gated by the lock, not sqlite.
      const lockB = opener(lockPath, 2, 50);
      await expect(runMigrations(db2, lockB)).rejects.toThrow(/migration lock/);

      // Once A releases, B proceeds and migrates the DB exactly once.
      await holder.release();
      await runMigrations(db2, opener(lockPath, 2));

      const rows = await db2
        .selectFrom("kysely_migration" as any)
        .select("name")
        .execute();
      expect(rows.length).toBe(await expectedMigrationCount());
    } finally {
      await db2.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two concurrent openers on the same DB file do not trip a PRIMARY KEY error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrator-concurrency-"));
    const dbPath = join(dir, "auto-mobile.db");
    const lockPath = `${dbPath}.migrate.lock`;

    const db1 = openFileDb(dbPath);
    const db2 = openFileDb(dbPath);

    try {
      await Promise.all([
        runMigrations(db1, opener(lockPath, 1)),
        runMigrations(db2, opener(lockPath, 2)),
      ]);

      // Exactly one opener wrote the history; the second observed an
      // already-migrated DB and wrote 0 new rows.
      const rows = await db1
        .selectFrom("kysely_migration" as any)
        .select("name")
        .execute();
      expect(rows.length).toBe(await expectedMigrationCount());
    } finally {
      await db1.destroy();
      await db2.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a second opener still migrates after the first opener fails mid-migration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrator-failrelease-"));
    const dbPath = join(dir, "auto-mobile.db");
    const lockPath = `${dbPath}.migrate.lock`;

    const dbA = openFileDb(dbPath);
    const dbB = openFileDb(dbPath);
    const previous = process.env.AUTOMOBILE_MIGRATIONS_DIR;

    try {
      // Opener A acquires the real lock, then fails (bad migrations folder). Its
      // finally-release must free the lock so B is not wedged.
      process.env.AUTOMOBILE_MIGRATIONS_DIR = join(tmpdir(), "auto-mobile-missing-migrations");
      await expect(runMigrations(dbA, opener(lockPath, 1))).rejects.toBeDefined();

      // Restore the real migrations folder; B acquires cleanly and migrates.
      if (previous === undefined) {
        delete process.env.AUTOMOBILE_MIGRATIONS_DIR;
      } else {
        process.env.AUTOMOBILE_MIGRATIONS_DIR = previous;
      }
      await runMigrations(dbB, opener(lockPath, 2));

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
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
