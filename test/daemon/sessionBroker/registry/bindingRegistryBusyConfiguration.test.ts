import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  BINDING_REGISTRY_BUSY_TIMEOUT_MS,
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { BEGIN_TRANSACTION_SQL } from "../../../../src/db/bunSqliteDialect";
import { classifySqliteError } from "../../../../src/db/databaseFailureClassification";
import { defaultTimer } from "../../../../src/utils/SystemTimer";
import { logger } from "../../../../src/utils/logger";

const SCOPE = { managedHostScope: "test", runnerNamespace: "busy", runnerIncarnation: "one" };

describe("registry busy configuration", () => {
  let registry: SqliteBindingRegistry;
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
      registry = await openSqliteBindingRegistry({ dbPath: ":memory:" });
    } finally {
      capture.mockRestore();
    }
  });
  afterAll(async () => {
    await registry?.close();
  });

  test("configures a 250ms busy timeout on the registry connection", () => {
    expect(BINDING_REGISTRY_BUSY_TIMEOUT_MS).toBe(250);
    expect(busyTimeout).toBe(BINDING_REGISTRY_BUSY_TIMEOUT_MS);
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
      await expect(openSqliteBindingRegistry({ dbPath: ":memory:" })).rejects.toMatchObject({
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
