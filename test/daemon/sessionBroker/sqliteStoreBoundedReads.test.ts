import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../../src/db/bunSqliteDialect";
import { migrateBindingRegistry } from "../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import type { BindingRegistryDatabase } from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { SqliteSessionBrokerStore } from "../../../src/daemon/sessionBroker/sqliteStore";
import type {
  BrokerRequestsTable,
  BrokerResourcesTable,
} from "../../../src/daemon/sessionBroker/store";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

const OWNER = { daemonId: "owner", pid: 1 };

describe("bounded broker reads and tombstone lifetime", () => {
  let sqlite: Database;
  let db: Kysely<BindingRegistryDatabase>;
  let store: SqliteSessionBrokerStore;
  let timer: FakeTimer;
  let queries: string[];

  beforeAll(async () => {
    sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    queries = [];
    db = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: sqlite }),
      log: (event) => {
        queries.push(event.query.sql);
      },
    });
    await migrateBindingRegistry(db, ":memory:");
  });

  beforeEach(() => {
    sqlite.exec(`DELETE FROM session_broker_exports;
      DELETE FROM session_broker_resources;
      DELETE FROM session_broker_requests;`);
    queries = [];
    timer = new FakeTimer();
    timer.setCurrentTime(10_000);
    store = new SqliteSessionBrokerStore(db, "scope", () => true, {
      ids: new CountingIdGenerator("new"),
      clock: timer,
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  function request(
    id: string,
    state: BrokerRequestsTable["state"],
    resourceId: string | null,
    time = 0,
  ) {
    sqlite
      .prepare(`INSERT INTO session_broker_requests
      (request_id, fingerprint, parameters_json, owner_json, state, resource_id, terminal_at_ms)
      VALUES (?, 'fp', '{}', ?, ?, ?, ?)`)
      .run(id, JSON.stringify(OWNER), state, resourceId, time);
  }

  function resource(id: string, state: BrokerResourcesTable["state"], requestId: string | null) {
    sqlite
      .prepare(`INSERT INTO session_broker_resources
      (resource_id, scope_key, profile_json, state, request_id, revision, idle_order)
      VALUES (?, 'scope', '{"model":"phone"}', ?, ?, 1, 0)`)
      .run(id, state, requestId);
  }

  test("confirmDestroyed deletes an unreferenced trimmed idle resource", async () => {
    resource("trimmed", "destroying", null);
    expect(await store.confirmDestroyed({ resourceId: "trimmed", revision: 1 })).toBe(true);
    expect(await store.listResources()).toEqual([]);
  });

  test("confirmDestroyed keeps a null-owner tombstone named by a retained receipt", async () => {
    request("released", "released", "trimmed");
    resource("trimmed", "destroying", null);
    const ticket = { resourceId: "trimmed", revision: 1 };
    expect(await store.confirmDestroyed(ticket)).toBe(true);
    expect(await store.confirmDestroyed(ticket)).toBe(true);
    expect(await store.getResource("trimmed")).toMatchObject({
      state: "destroyed",
      profile: { model: "phone" },
    });
  });

  test("prune sweeps orphan tombstones even without expired receipts, keeping live resources", async () => {
    resource("orphan", "destroyed", null);
    resource("idle", "idle", null);
    resource("pending", "destroying", null);
    expect(await store.pruneTerminalRequests(1_000, 1)).toBe(0);
    expect((await store.listResources()).map((entry) => entry.resourceId)).toEqual([
      "idle",
      "pending",
    ]);
  });

  test("pruning an owner retains another receipt's profile, then sweeps the nulled tombstone", async () => {
    request("old", "released", "shared");
    request("retained", "released", "shared", 10_000);
    resource("shared", "destroyed", "old");
    resource("orphan", "destroyed", null);
    expect(await store.pruneTerminalRequests(1_000, 10)).toBe(1);
    expect(await store.getResource("shared")).toMatchObject({
      requestId: null,
      state: "destroyed",
    });
    expect(await store.getResource("orphan")).toBeUndefined();
    timer.advanceTime(1_000);
    expect(await store.pruneTerminalRequests(1_000, 10)).toBe(1);
    expect(await store.listResources()).toEqual([]);
  });

  test("single-row lookup uses its id predicate and does not parse unrelated profiles", async () => {
    request("retained", "released", "target");
    resource("target", "destroyed", null);
    resource("unrelated", "active", null);
    sqlite.exec(
      "UPDATE session_broker_resources SET profile_json='invalid JSON' WHERE resource_id='unrelated'",
    );
    queries.length = 0;
    expect(await store.getResource("target")).toMatchObject({ state: "destroyed" });
    expect(await store.getResource("missing")).toBeUndefined();
    expect(queries).toHaveLength(2);
    expect(queries.every((query) => query.includes('where "resource_id" = ?'))).toBe(true);
  });

  test("occupancy reads skip tombstone JSON during reserve and in the recovery snapshot", async () => {
    resource("dead", "destroyed", null);
    sqlite.exec("UPDATE session_broker_resources SET profile_json='invalid JSON'");
    expect(await store.listLiveResources()).toEqual([]);
    expect(
      await store.admit({
        requestId: "next",
        fingerprint: "fp",
        parameters: {},
        owner: OWNER,
        limits: { sessionCap: 1, totalDeviceCap: 1 },
        matches: () => false,
        resolveCreation: () => ({}),
      }),
    ).toMatchObject({ kind: "create" });
  });

  // Golden boundary answers captured by running origin/main's admit on these exact fixtures.
  // cap=count refuses; cap=count+1 admits. No timing assertions or copied count implementation.
  const cases: readonly [
    string,
    BrokerRequestsTable["state"],
    BrokerResourcesTable["state"] | null,
    "same" | "other" | "none",
    number,
  ][] = [
    ["acquiring without resource", "acquiring", null, "none", 1],
    ["active without resource", "active", null, "none", 1],
    ["releasing without resource", "releasing", null, "none", 1],
    ["released with live resource", "released", "active", "same", 0],
    ["failed without resource", "failed", null, "none", 0],
    ["failed destroyed", "failed", "destroyed", "same", 0],
    ["failed reserved", "failed", "reserved", "same", 1],
    ["failed active", "failed", "active", "same", 1],
    ["failed resetting", "failed", "resetting", "same", 1],
    ["failed destroying", "failed", "destroying", "same", 1],
    ["failed unknown", "failed", "unknown", "same", 1],
    ["failed idle", "failed", "idle", "same", 1],
    ["failed reused resource", "failed", "active", "other", 0],
    ["failed null owner", "failed", "active", "none", 0],
  ];
  test.each(cases)(
    "admission matches old count: %s",
    async (_name, state, resourceState, owner, count) => {
      request("fixture", state, resourceState ? "fixture-resource" : null);
      if (owner === "other") {
        request("other", "released", null);
      }
      if (resourceState) {
        resource(
          "fixture-resource",
          resourceState,
          owner === "same" ? "fixture" : owner === "other" ? "other" : null,
        );
      }
      const input = {
        requestId: "boundary",
        fingerprint: "fp",
        parameters: {},
        owner: OWNER,
        limits: { sessionCap: count },
        matches: () => false,
        resolveCreation: () => ({}),
      };
      expect(await store.admit(input)).toMatchObject({
        kind: "refused",
        reason: "session-cap-reached",
      });
      expect(
        await store.admit({ ...input, requestId: "above", limits: { sessionCap: count + 1 } }),
      ).toMatchObject({ kind: "create" });
    },
  );
});
