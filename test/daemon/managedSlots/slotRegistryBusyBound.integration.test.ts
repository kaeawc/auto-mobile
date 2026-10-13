import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  MANAGED_SLOT_REGISTRY_BUSY_TIMEOUT_MS,
  openSqliteSlotRegistry,
} from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { BEGIN_TRANSACTION_SQL } from "../../../src/db/bunSqliteDialect";
import { classifySqliteError } from "../../../src/db/databaseFailureClassification";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import { logger } from "../../../src/utils/logger";
import { useScratchRoot } from "../../helpers/scratchRoot";

const SCOPE = { managedHostScope: "test", runnerNamespace: "busy", runnerIncarnation: "one" };

describe("registry busy bound (real SQLite)", () => {
  const scratch = useScratchRoot("slot-busy-bound-");

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
    const registry = await openSqliteSlotRegistry({ dbPath });
    const peer = new Database(dbPath);
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
    let locked = false;
    try {
      peer.exec("BEGIN IMMEDIATE");
      locked = true;
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
        await registry.close();
      }
    }
  });
});
