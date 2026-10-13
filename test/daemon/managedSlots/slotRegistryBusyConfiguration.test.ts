import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  MANAGED_SLOT_REGISTRY_BUSY_TIMEOUT_MS,
  openSqliteSlotRegistry,
  type SqliteSlotRegistry,
} from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { BEGIN_TRANSACTION_SQL } from "../../../src/db/bunSqliteDialect";
import { classifySqliteError } from "../../../src/db/databaseFailureClassification";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import { logger } from "../../../src/utils/logger";
import { useScratchRoot } from "../../helpers/scratchRoot";

const SCOPE = { managedHostScope: "test", runnerNamespace: "busy", runnerIncarnation: "one" };

describe("registry busy configuration", () => {
  const scratch = useScratchRoot("slot-busy-config-");
  let registry: SqliteSlotRegistry;
  let migratedPath: string;
  let busyTimeout: number | undefined;

  beforeAll(async () => {
    const exec = Database.prototype.exec;
    const capture = spyOn(Database.prototype, "exec").mockImplementation(function (
      this: Database,
      sql: string,
    ) {
      const result = exec.call(this, sql);
      // Read the configured pragma on the actual registry handle, before migration.
      busyTimeout = this.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout;
      return result;
    });
    try {
      registry = await openSqliteSlotRegistry({ dbPath: ":memory:" });
    } finally {
      capture.mockRestore();
    }
    migratedPath = join(scratch.next(), "slots.sqlite");
    const migrated = await openSqliteSlotRegistry({ dbPath: migratedPath });
    await migrated.close();
  });
  afterAll(async () => {
    await registry?.close();
  });

  test("configures a 250ms busy timeout on the registry connection", () => {
    expect(MANAGED_SLOT_REGISTRY_BUSY_TIMEOUT_MS).toBe(250);
    expect(busyTimeout).toBe(MANAGED_SLOT_REGISTRY_BUSY_TIMEOUT_MS);
  });

  test("opening a migrated registry never issues BEGIN IMMEDIATE or close maintenance", async () => {
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
    try {
      const opened = await openSqliteSlotRegistry({ dbPath: migratedPath });
      try {
        expect(statements).not.toContain(BEGIN_TRANSACTION_SQL);
        expect(await opened.listFreeDevices()).toEqual([]);
      } finally {
        await opened.close();
      }
      expect(exec.mock.calls.map(([sql]) => sql)).not.toContain("PRAGMA optimize;");
      expect(exec.mock.calls.map(([sql]) => sql)).not.toContain("PRAGMA wal_checkpoint(TRUNCATE);");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      query.mockRestore();
      exec.mockRestore();
      close.mockRestore();
    }
  });

  test("a busy initialization PRAGMA closes its handle and refuses retryably", async () => {
    const exec = Database.prototype.exec;
    const query = spyOn(Database.prototype, "exec").mockImplementation(function (
      this: Database,
      sql: string,
    ) {
      if (sql === "PRAGMA journal_mode = WAL;") {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return exec.call(this, sql);
    });
    const close = spyOn(Database.prototype, "close");
    try {
      await expect(openSqliteSlotRegistry({ dbPath: ":memory:" })).rejects.toMatchObject({
        code: "discovery_incomplete",
        retryable: true,
      });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      query.mockRestore();
      close.mockRestore();
    }
  });

  test("attempts a busy BEGIN once without scheduling a dialect retry or warning", async () => {
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const prepare = Database.prototype.prepare;
    let attempts = 0;
    const query = spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database,
      sql: string,
    ) {
      if (sql === BEGIN_TRANSACTION_SQL) {
        attempts++;
        throw busy;
      }
      return prepare.call(this, sql);
    });
    const sleep = spyOn(defaultTimer, "sleep");
    const warn = spyOn(logger, "warn");
    try {
      const error = await registry.ensureScope(SCOPE).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(classifySqliteError(error)).toBe("retryable");
      expect(attempts).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      query.mockRestore();
      sleep.mockRestore();
      warn.mockRestore();
    }
  });
});
