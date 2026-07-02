import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Kysely } from "kysely";
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

function migrationCount(): number {
  return readdirSync(resolveMigrationFolder()).filter(name => name.endsWith(".ts") || name.endsWith(".js")).length;
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

  test("two concurrent openers on the same DB file do not trip a PRIMARY KEY error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrator-concurrency-"));
    const dbPath = join(dir, "auto-mobile.db");
    const lockPath = `${dbPath}.migrate.lock`;

    const makeLock = (pid: number): FileMigrationLock => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      return new FileMigrationLock(lockPath, {
        timer,
        pid,
        pollIntervalMs: 5,
        timeoutMs: 60_000,
        // Distinct virtual pids; both "alive" so the file lock (wx) is the only
        // arbiter between the two in-process openers.
        isProcessRunning: candidate => candidate === 1 || candidate === 2,
      });
    };

    const db1 = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(dbPath) }),
    });
    const db2 = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(dbPath) }),
    });

    try {
      await Promise.all([
        runMigrations(db1, makeLock(1)),
        runMigrations(db2, makeLock(2)),
      ]);

      // Exactly one opener wrote the history; the second observed an
      // already-migrated DB and wrote 0 new rows.
      const rows = await db1
        .selectFrom("kysely_migration" as any)
        .select("name")
        .execute();
      expect(rows.length).toBe(migrationCount());
    } finally {
      await db1.destroy();
      await db2.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
