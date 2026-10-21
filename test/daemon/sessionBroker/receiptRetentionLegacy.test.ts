import { Database as Sqlite } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../../src/db/bunSqliteDialect";
import { migrateBindingRegistry } from "../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import type { BindingRegistryDatabase } from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { SqliteSessionBrokerStore } from "../../../src/daemon/sessionBroker/sqliteStore";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

const WINDOW_MS = 1_000;

describe("receipt retention for receipts written before it existed", () => {
  test("an unstamped terminal receipt gets a full window from the first retention pass", async () => {
    const sqlite = new Sqlite(":memory:");
    const db = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: sqlite }),
    });
    try {
      await migrateBindingRegistry(db, ":memory:");
      sqlite.exec(`INSERT INTO session_broker_requests
        (request_id, fingerprint, parameters_json, owner_json, state, error, error_code, retryable)
        VALUES ('legacy', 'fingerprint', '{}', '{}', 'failed', 'refused', 'capacity_exhausted', 0)`);
      const timer = new FakeTimer();
      timer.setCurrentTime(50_000);
      const store = new SqliteSessionBrokerStore(
        db,
        "scope",
        () => false,
        new CountingIdGenerator("resource"),
        timer,
      );
      expect(await store.pruneTerminalRequests(WINDOW_MS, 10)).toBe(0);
      timer.advanceTime(WINDOW_MS - 1);
      expect(await store.pruneTerminalRequests(WINDOW_MS, 10)).toBe(0);
      expect(await store.getRequest("legacy")).toMatchObject({ state: "failed" });
      timer.advanceTime(1);
      expect(await store.pruneTerminalRequests(WINDOW_MS, 10)).toBe(1);
      expect(await store.getRequest("legacy")).toBeUndefined();
    } finally {
      await db.destroy();
    }
  });
});
