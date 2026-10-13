import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import {
  MANAGED_SLOT_REGISTRY_BUSY_TIMEOUT_MS,
  openSqliteSlotRegistry,
  type SqliteSlotRegistry,
} from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { BEGIN_TRANSACTION_SQL, BunSqliteDialect } from "../../../src/db/bunSqliteDialect";
import { slotRegistryMigrationProvider } from "../../../src/daemon/managedSlots/slotRegistryMigrations";
import { classifySqliteError } from "../../../src/db/databaseFailureClassification";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import { logger } from "../../../src/utils/logger";
import { useScratchRoot } from "../../helpers/scratchRoot";

const SCOPE = { managedHostScope: "test", runnerNamespace: "busy", runnerIncarnation: "one" };

describe("registry busy bound (real SQLite)", () => {
  const scratch = useScratchRoot("slot-busy-bound-");

  test("a pending migration fails once under a peer lock, closes without maintenance, and retries atomically", async () => {
    const dbPath = join(scratch.next(), "slots.sqlite");
    const seed = new Database(dbPath);
    seed.exec("PRAGMA journal_mode = WAL;");
    const db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: seed }) });
    try {
      const result = await new Migrator({ db, provider: slotRegistryMigrationProvider }).migrateTo(
        "2026_10_10_003_free_device_stop_state",
      );
      expect(result.error).toBeUndefined();
    } finally {
      await db.destroy();
    }
    const peer = new Database(dbPath);
    const peerDb = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: peer }) });
    await new Migrator({ db: peerDb, provider: slotRegistryMigrationProvider }).getMigrations();
    peer.exec("BEGIN IMMEDIATE");
    const prepare = Database.prototype.prepare;
    const statements: string[] = [];
    const query = spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database,
      sql: string,
    ) {
      statements.push(sql);
      return prepare.call(this, sql);
    });
    const exec = spyOn(Database.prototype, "exec");
    const close = spyOn(Database.prototype, "close");
    let locked = true;
    try {
      const started = performance.now();
      await expect(openSqliteSlotRegistry({ dbPath })).rejects.toMatchObject({
        code: "discovery_incomplete",
        retryable: true,
      });
      expect(performance.now() - started).toBeLessThan(
        2 * MANAGED_SLOT_REGISTRY_BUSY_TIMEOUT_MS + 500,
      );
      expect(statements.filter((sql) => sql === BEGIN_TRANSACTION_SQL)).toHaveLength(1);
      expect(exec.mock.calls.map(([sql]) => sql)).not.toContain("PRAGMA optimize;");
      expect(exec.mock.calls.map(([sql]) => sql)).not.toContain("PRAGMA wal_checkpoint(TRUNCATE);");
      expect(close).toHaveBeenCalledTimes(1);
      expect(
        peer
          .query<{ name: string }, []>("PRAGMA table_info(slot_free_devices)")
          .all()
          .some((column) => column.name === "deletion_owner_pid"),
      ).toBe(false);
      const pending = await new Migrator({
        db: peerDb,
        provider: slotRegistryMigrationProvider,
      }).getMigrations();
      expect(pending.filter((migration) => migration.executedAt === undefined)).toHaveLength(1);
      peer.exec("COMMIT");
      locked = false;
      const reopened = await openSqliteSlotRegistry({ dbPath });
      try {
        const migrated = await new Migrator({
          db: peerDb,
          provider: slotRegistryMigrationProvider,
        }).getMigrations();
        expect(migrated.every((migration) => migration.executedAt !== undefined)).toBe(true);
        expect((await reopened.ensureScope(SCOPE)).kind).toBe("ready");
        expect(await reopened.listFreeDevices()).toEqual([]);
      } finally {
        await reopened.close();
      }
    } finally {
      query.mockRestore();
      exec.mockRestore();
      close.mockRestore();
      try {
        if (locked) {
          peer.exec("ROLLBACK");
        }
      } finally {
        await peerDb.destroy();
      }
    }
  });

  test("a busy migration rolls back partial ALTERs and the next open succeeds", async () => {
    const dbPath = join(scratch.next(), "slots.sqlite");
    const prepare = Database.prototype.prepare;
    let refused = false;
    const query = spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database,
      sql: string,
    ) {
      if (!refused && sql.includes("ADD COLUMN") && sql.includes("deletion_owner_pid")) {
        refused = true;
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return prepare.call(this, sql);
    });
    try {
      await expect(openSqliteSlotRegistry({ dbPath })).rejects.toMatchObject({
        code: "discovery_incomplete",
        retryable: true,
      });
      expect(refused).toBe(true);
    } finally {
      query.mockRestore();
    }
    const reopened = await openSqliteSlotRegistry({ dbPath });
    try {
      expect((await reopened.ensureScope(SCOPE)).kind).toBe("ready");
    } finally {
      await reopened.close();
    }
  });

  test("one busy attempt is bounded and the same write succeeds after the peer commits", async () => {
    const dbPath = join(scratch.next(), "slots.sqlite");
    const initial = await openSqliteSlotRegistry({ dbPath });
    await initial.close();
    const peer = new Database(dbPath);
    peer.exec("BEGIN IMMEDIATE");
    let registry: SqliteSlotRegistry | undefined;
    const prepare = Database.prototype.prepare;
    const runs: Array<ReturnType<typeof spyOn>> = [];
    let attempts = 0;
    const query = spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database,
      sql: string,
    ) {
      const statement = prepare.call(this, sql);
      if (sql === BEGIN_TRANSACTION_SQL) {
        const run = statement.run;
        runs.push(
          spyOn(statement, "run").mockImplementation(function (
            this: typeof statement,
            ...args: Parameters<typeof run>
          ) {
            attempts++;
            return run.apply(this, args);
          }),
        );
      }
      return statement;
    });
    const sleep = spyOn(defaultTimer, "sleep");
    const warn = spyOn(logger, "warn");
    let locked = true;
    try {
      registry = await openSqliteSlotRegistry({ dbPath });
      expect(await registry.snapshotManagedDevices()).toEqual([]);
      expect(await registry.listFreeDevices()).toEqual([]);
      const started = performance.now();
      const error = await registry.ensureScope(SCOPE).then(
        () => undefined,
        (error: unknown) => error,
      );
      const elapsedMs = performance.now() - started;
      expect(classifySqliteError(error)).toBe("retryable");
      expect(attempts).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
      expect(elapsedMs).toBeLessThan(2 * MANAGED_SLOT_REGISTRY_BUSY_TIMEOUT_MS + 500);
      peer.exec("COMMIT");
      locked = false;
      expect((await registry.ensureScope(SCOPE)).kind).toBe("ready");
      expect(attempts).toBe(2);
      peer.exec("BEGIN IMMEDIATE");
      locked = true;
      const closeStarted = performance.now();
      await registry.close();
      expect(performance.now() - closeStarted).toBeLessThan(500);
    } finally {
      query.mockRestore();
      for (const run of runs) {
        run.mockRestore();
      }
      sleep.mockRestore();
      warn.mockRestore();
      // Release the lock and close BOTH handles before useScratchRoot removes the file on Windows.
      try {
        if (locked) {
          peer.exec("ROLLBACK");
        }
      } finally {
        peer.close();
        await registry?.close();
      }
    }
  });
});
