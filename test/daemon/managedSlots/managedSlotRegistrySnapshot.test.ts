import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  Kysely,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
} from "kysely";
import { BunSqliteDialect } from "../../../src/db/bunSqliteDialect";
import { migrateSlotRegistry } from "../../../src/daemon/managedSlots/slotRegistryMigrations";
import {
  SqliteSlotRegistry,
  type SlotRegistryDatabase,
} from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { assignManagedSlotDevice } from "./managedSlotFixtures";
import { FakeTimer } from "../../fakes/FakeTimer";

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
  let db: Kysely<SlotRegistryDatabase>;
  let plugin: SnapshotInterleave;
  let registry: SqliteSlotRegistry;
  beforeEach(async () => {
    raw = new Database(":memory:");
    plugin = new SnapshotInterleave();
    db = new Kysely<SlotRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: raw }),
      plugins: [plugin],
    });
    await migrateSlotRegistry(db, ":memory:");
    registry = new SqliteSlotRegistry(db, { timer: new FakeTimer(), isExecOwnerLive: () => false });
  });
  afterEach(async () => {
    await db.destroy();
  });

  describe("atomic adoption", () => {
    beforeEach(async () => {
      const cached = await assignManagedSlotDevice(registry, "android", "amslot-cache", "cache");
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
      const key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
      await registry.initSlot(key, { role: "primary", platform: "android", requestedSpec: {} });
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
    });
    test("a binding commit between internal reads cannot omit or double-count an adopted image", async () => {
      plugin.armed = true;
      const before = await registry.snapshotManagedDevices();
      plugin.armed = false;
      expect(before.map((row) => row.stableDeviceId)).toEqual(["amslot-cache"]);
      expect(plugin.reads).toBe(1);
      expect(await registry.snapshotManagedDevices()).toMatchObject([
        { holder: "slot", stableDeviceId: "amslot-cache" },
      ]);
    });
  });

  test.each([false, true])(
    "a duplicate free row never licenses deleting an assignment (abandoned=%s)",
    async (abandoned) => {
      const key = await assignManagedSlotDevice(registry, "android", "amslot-bound", "bound");
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
