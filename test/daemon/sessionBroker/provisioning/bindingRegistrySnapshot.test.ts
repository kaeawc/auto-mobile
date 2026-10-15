import { warmedTests } from "../../../helpers/warmedTests";
import { afterAll, describe, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  Kysely,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
} from "kysely";
import { BunSqliteDialect } from "../../../../src/db/bunSqliteDialect";
import { migrateBindingRegistry } from "../../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import {
  SqliteBindingRegistry,
  type BindingRegistryDatabase,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { assignBindingDevice } from "./bindingFixtures";
import { FakeTimer } from "../../../fakes/FakeTimer";

class SnapshotInterleave implements KyselyPlugin {
  armed = false;
  reads = 0;
  afterFirstRead: () => void = () => {};
  transformQuery(args: PluginTransformQueryArgs) {
    return args.node;
  }
  async transformResult(args: PluginTransformResultArgs) {
    if (this.armed) {
      this.reads += 1;
      if (this.reads === 1) {
        this.afterFirstRead();
      }
    }
    return args.result;
  }
}

describe("SQLite managed-resource snapshot", () => {
  let raw: Database;
  let db: Kysely<BindingRegistryDatabase>;
  let plugin: SnapshotInterleave;
  let registry: SqliteBindingRegistry;
  let queries: string[];
  const test = warmedTests(async () => {
    await db?.destroy();
    raw = new Database(":memory:");
    plugin = new SnapshotInterleave();
    queries = [];
    db = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: raw }),
      plugins: [plugin],
      log: (event) => {
        if (event.level === "query") {
          queries.push(event.query.sql);
        }
      },
    });
    await migrateBindingRegistry(db, ":memory:");
    registry = new SqliteBindingRegistry(db, {
      timer: new FakeTimer(),
      isExecOwnerLive: () => false,
    });
  });
  afterAll(async () => {
    await db.destroy();
  });

  test("generic snapshots do not read scope history and the ledger exposes only abandoned keys", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      scope_key: `history-${i}`,
      managed_host_scope: "host",
      runner_namespace: `history-${i}`,
      runner_incarnation: "inc",
      state: "invalidated" as const,
      invalidation_reason: "operator_reset" as const,
      created_at_ms: 0,
      last_acquired_at_ms: 0,
    }));
    await db.insertInto("slot_scopes").values(rows).execute();
    await db
      .updateTable("slot_scopes")
      .set({ state: "invalidating", invalidation_reason: "abandoned" })
      .where("scope_key", "=", "history-0")
      .execute();
    queries.length = 0;
    expect(await registry.snapshotManagedDevices()).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain('from "slot_scopes"');
    expect(await registry.snapshotBindingResources()).toMatchObject({
      abandonedScopeKeys: ["history-0"],
    });
  });

  describe("atomic adoption", () => {
    const prepareAdoption = async () => {
      const cached = await assignBindingDevice(registry, "android", "amslot-cache", "cache");
      await registry.beginScopeInvalidation(cached.scopeKey, "operator_reset");
      await registry.completeScopeInvalidation(cached.scopeKey);
      const scope = await registry.ensureScope({
        managedHostScope: "host",
        runnerNamespace: "adopter",
        runnerIncarnation: "inc",
      });
      if (scope.kind !== "ready") {
        throw new Error(scope.kind);
      }
      const key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
      await registry.initBinding(key, { role: "primary", platform: "android", requestedSpec: {} });
      // Commit just after the first statement's results arrive. Before the fix, assignments
      // were read before this commit and free rows after it, so the device disappeared.
      plugin.afterFirstRead = () => {
        raw.transaction(() => {
          raw
            .query(
              "UPDATE slot_assignments SET stable_device_id = ?, device_name = ?, generation = 1 WHERE scope_key = ? AND slot_index = 0",
            )
            .run("amslot-cache", "amslot-cache", key.scopeKey);
          raw
            .query("DELETE FROM slot_free_devices WHERE platform = ? AND stable_device_id = ?")
            .run("android", "amslot-cache");
        })();
      };
      // Warm the read codec without arming the interleaving hook or mutating the fixture.
      await registry.snapshotManagedDevices();
    };
    test("a binding commit between internal reads cannot omit or double-count an adopted image", async () => {
      await prepareAdoption();
      plugin.armed = true;
      const before = await registry.snapshotManagedDevices();
      plugin.armed = false;
      expect(before.map((row) => row.stableDeviceId)).toEqual(["amslot-cache"]);
      expect(plugin.reads).toBe(1);
      expect(await registry.snapshotManagedDevices()).toMatchObject([
        { holder: "binding", stableDeviceId: "amslot-cache" },
      ]);
    });
  });

  test.each([false, true])(
    "a duplicate free row never licenses deleting an assignment (abandoned=%s)",
    async (abandoned) => {
      const key = await assignBindingDevice(registry, "android", "amslot-bound", "bound");
      if (abandoned) {
        await registry.markScopeAbandoned(key.scopeKey, { thresholdMs: 0 });
        await registry.completeScopeInvalidation(key.scopeKey);
      }
      raw
        .query(
          "INSERT INTO slot_free_devices (platform, stable_device_id, from_scope_key, freed_at_ms) VALUES (?, ?, ?, ?)",
        )
        .run("android", "amslot-bound", "old", 0);
      const row = (await registry.listFreeDevices())[0];
      expect(await registry.beginFreeDeviceDeletion(row, { daemonId: "test", pid: 11 })).toEqual({
        kind: "not_evictable",
        reason: "assigned",
      });
      expect((await registry.listFreeDevices())[0].deletion).toBeNull();
      expect(await registry.getAssignment(key)).toMatchObject({ stableDeviceId: "amslot-bound" });
    },
  );
});
