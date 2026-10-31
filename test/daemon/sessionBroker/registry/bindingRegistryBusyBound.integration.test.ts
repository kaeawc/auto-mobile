import { describe, expect, spyOn, test } from "bun:test";
import { spyOnDatabasePrepare } from "../../../helpers/sqlitePrepareSpy";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import {
  BINDING_REGISTRY_BUSY_TIMEOUT_MS,
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { BEGIN_TRANSACTION_SQL, BunSqliteDialect } from "../../../../src/db/bunSqliteDialect";
import {
  bindingRegistryMigrationProvider,
  BROKER_TIMING_MIGRATION,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import { classifySqliteError } from "../../../../src/db/databaseFailureClassification";
import { defaultTimer } from "../../../../src/utils/SystemTimer";
import { logger } from "../../../../src/utils/logger";
import { useScratchRoot } from "../../../helpers/scratchRoot";

import {
  bindFileBackedDbHarness,
  WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
} from "../../../db/withFileBackedDb";

const SCOPE = { managedHostScope: "test", runnerNamespace: "busy", runnerIncarnation: "one" };

// Real SQLite on a loaded Windows runner took 1839 ms for a 1000 ms bound. These
// bounds catch an unbounded wait, not a slow host.
const WALL_CLOCK_SLACK_MS = process.platform === "win32" ? 5_000 : 500;

describe("registry busy bound (real SQLite)", () => {
  const scratch = useScratchRoot("binding-busy-bound-");

  test("a pending migration fails once under a peer lock, closes without maintenance, and retries atomically", async () => {
    const dbPath = join(scratch.next(), "slots.sqlite");
    const seed = new Database(dbPath);
    seed.exec("PRAGMA journal_mode = WAL;");
    const db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: seed }) });
    try {
      const result = await new Migrator({
        db,
        provider: bindingRegistryMigrationProvider,
      }).migrateTo("2026_10_10_003_free_device_stop_state");
      expect(result.error).toBeUndefined();
    } finally {
      await db.destroy();
    }
    const peer = new Database(dbPath);
    const peerDb = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: peer }) });
    await new Migrator({ db: peerDb, provider: bindingRegistryMigrationProvider }).getMigrations();
    peer.exec("BEGIN IMMEDIATE");
    const statements: string[] = [];
    const query = spyOnDatabasePrepare({ beforePrepare: (sql) => statements.push(sql) });
    const exec = spyOn(Database.prototype, "exec");
    const close = spyOn(Database.prototype, "close");
    let locked = true;
    try {
      const started = performance.now();
      await expect(openSqliteBindingRegistry({ dbPath })).rejects.toMatchObject({
        code: "discovery_incomplete",
        retryable: true,
      });
      expect(performance.now() - started).toBeLessThan(
        2 * BINDING_REGISTRY_BUSY_TIMEOUT_MS + WALL_CLOCK_SLACK_MS,
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
        provider: bindingRegistryMigrationProvider,
      }).getMigrations();
      expect(
        pending
          .filter((migration) => migration.executedAt === undefined)
          .map((migration) => migration.name),
      ).toEqual([
        "2026_10_12_004_free_device_deletion",
        "2026_10_13_005_free_device_deletion_failed_deletes",
        "2026_10_15_006_session_broker",
        "2026_10_15_007_session_broker_failure_retryable",
        "2026_10_16_008_retire_slot_features",
        "2026_10_16_009_session_broker_receipt_retention",
        "2026_10_19_010_session_broker_exports",
        "2026_10_20_011_session_broker_resource_indexes",
        "2026_10_21_012_device_mutation_journal",
        BROKER_TIMING_MIGRATION,
        "2026_10_26_014_device_claims",
        "2026_10_27_015_device_claims_metadata",
        "2026_10_30_016_watchos_binding_platform",
        "2026_10_31_017_binding_registry_writers",
      ]);
      peer.exec("COMMIT");
      locked = false;
      const reopened = await openSqliteBindingRegistry({ dbPath });
      try {
        const migrated = await new Migrator({
          db: peerDb,
          provider: bindingRegistryMigrationProvider,
        }).getMigrations();
        expect(migrated.every((migration) => migration.executedAt !== undefined)).toBe(true);
        expect((await reopened.ensureScope(SCOPE)).kind).toBe("ready");
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
    let refused = false;
    const query = spyOnDatabasePrepare({
      beforePrepare: (sql) => {
        if (!refused && sql.includes("ADD COLUMN") && sql.includes("deletion_owner_pid")) {
          refused = true;
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
      },
    });
    try {
      await expect(openSqliteBindingRegistry({ dbPath })).rejects.toMatchObject({
        code: "discovery_incomplete",
        retryable: true,
      });
      expect(refused).toBe(true);
    } finally {
      query.mockRestore();
    }
    const reopened = await openSqliteBindingRegistry({ dbPath });
    try {
      expect((await reopened.ensureScope(SCOPE)).kind).toBe("ready");
    } finally {
      await reopened.close();
    }
  });

  test("one busy attempt is bounded and the same write succeeds after the peer commits", async () => {
    const dbPath = join(scratch.next(), "slots.sqlite");
    const initial = await openSqliteBindingRegistry({ dbPath });
    await initial.close();
    const peer = new Database(dbPath);
    peer.exec("BEGIN IMMEDIATE");
    let registry: SqliteBindingRegistry | undefined;
    const runs: Array<ReturnType<typeof spyOn>> = [];
    let attempts = 0;
    const query = spyOnDatabasePrepare({
      afterPrepare: (sql, statement) => {
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
      },
    });
    const sleep = spyOn(defaultTimer, "sleep");
    const warn = spyOn(logger, "warn");
    let locked = true;
    try {
      registry = await openSqliteBindingRegistry({ dbPath });
      expect(await registry.snapshotManagedDevices()).toEqual([]);
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
      expect(elapsedMs).toBeLessThan(2 * BINDING_REGISTRY_BUSY_TIMEOUT_MS + WALL_CLOCK_SLACK_MS);
      peer.exec("COMMIT");
      locked = false;
      expect((await registry.ensureScope(SCOPE)).kind).toBe("ready");
      expect(attempts).toBe(2);
      peer.exec("BEGIN IMMEDIATE");
      locked = true;
      const closeStarted = performance.now();
      await registry.close();
      expect(performance.now() - closeStarted).toBeLessThan(WALL_CLOCK_SLACK_MS);
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

describe("migrated registry open (real SQLite file)", () => {
  const getHarness = bindFileBackedDbHarness();

  test(
    "opening a migrated registry never issues BEGIN IMMEDIATE or close maintenance",
    async () => {
      const dbPath = join(await getHarness().makeTempDbDir("am-bindings-"), "slots.sqlite");
      const migrated = await openSqliteBindingRegistry({ dbPath });
      await migrated.close();
      const statements: string[] = [];
      const query = spyOnDatabasePrepare({ beforePrepare: (sql) => statements.push(sql) });
      const exec = spyOn(Database.prototype, "exec");
      const close = spyOn(Database.prototype, "close");
      try {
        const opened = await openSqliteBindingRegistry({ dbPath });
        try {
          expect(statements).not.toContain(BEGIN_TRANSACTION_SQL);
        } finally {
          await opened.close();
        }
        expect(exec.mock.calls.map(([sql]) => sql)).not.toContain("PRAGMA optimize;");
        expect(exec.mock.calls.map(([sql]) => sql)).not.toContain(
          "PRAGMA wal_checkpoint(TRUNCATE);",
        );
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        query.mockRestore();
        exec.mockRestore();
        close.mockRestore();
      }
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );
});
