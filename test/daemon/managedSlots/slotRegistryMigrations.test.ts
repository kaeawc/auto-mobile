import { describe, expect, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../../src/db/bunSqliteDialect";
import * as freeStop003 from "../../../src/daemon/managedSlots/migrations/2026_10_10_003_free_device_stop_state";
import * as freeDeletion004 from "../../../src/daemon/managedSlots/migrations/2026_10_12_004_free_device_deletion";
import * as slotRegistry000 from "../../../src/daemon/managedSlots/migrations/2026_10_09_000_slot_registry";
import { migrateSlotRegistry } from "../../../src/daemon/managedSlots/slotRegistryMigrations";
import {
  SqliteSlotRegistry,
  type SlotRegistryDatabase,
} from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("slot registry migrations", () => {
  test("migration 004 preserves stopped images, defaults markers to null and preserves the state CHECK", async () => {
    const db = new Kysely<SlotRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: new Sqlite(":memory:") }),
    });
    try {
      await slotRegistry000.up(db as Kysely<unknown>);
      await freeStop003.up(db as Kysely<unknown>);
      await sql`INSERT INTO slot_free_devices (platform, stable_device_id, from_scope_key, freed_at_ms, state)
        VALUES ('android', 'amslot-old', 'scope', 12, 'stopped')`.execute(db);
      await freeDeletion004.up(db as Kysely<unknown>);
      const registry = new SqliteSlotRegistry(db, { timer: new FakeTimer() });
      expect(await registry.listFreeDevices()).toMatchObject([
        { stableDeviceId: "amslot-old", state: "stopped", deletion: null },
      ]);
      const row = await db.selectFrom("slot_free_devices").selectAll().executeTakeFirstOrThrow();
      expect(row.deletion_owner_pid).toBeNull();
      expect(row.deletion_next_attempt_at_ms).toBeNull();
      await expect(
        sql`UPDATE slot_free_devices SET state = 'deleting'`.execute(db),
      ).rejects.toThrow("CHECK");
      await freeDeletion004.down(db as Kysely<unknown>);
      await freeDeletion004.up(db as Kysely<unknown>);
      expect(await registry.listFreeDevices()).toMatchObject([
        { state: "stopped", deletion: null },
      ]);
    } finally {
      await db.destroy();
    }
  });

  test("free rows from before migration 003 become state free with no claim, nothing lost (#11337)", async () => {
    const db = new Kysely<SlotRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: new Sqlite(":memory:") }),
    });
    try {
      await slotRegistry000.up(db as Kysely<unknown>);
      await sql`INSERT INTO slot_free_devices (platform, stable_device_id, spec_fingerprint,
          from_scope_key, freed_at_ms)
        VALUES ('android', 'avd-1', 'fp-1', 'scope-old', 11),
               ('ios', 'UDID-2', NULL, 'scope-old', 22)`.execute(db);

      await migrateSlotRegistry(db, ":memory:");

      const registry = new SqliteSlotRegistry(db, {
        timer: new FakeTimer(),
        isExecOwnerLive: () => false,
      });
      expect(await registry.listFreeDevices()).toEqual([
        {
          platform: "android",
          stableDeviceId: "avd-1",
          specFingerprint: "fp-1",
          fromScopeKey: "scope-old",
          freedAtMs: 11,
          state: "free",
          stopClaimedBy: null,
          stopClaimedAtMs: null,
          deletion: null,
        },
        {
          platform: "ios",
          stableDeviceId: "UDID-2",
          specFingerprint: null,
          fromScopeKey: "scope-old",
          freedAtMs: 22,
          state: "free",
          stopClaimedBy: null,
          stopClaimedAtMs: null,
          deletion: null,
        },
      ]);
    } finally {
      await db.destroy();
    }
  });

  test("upgrading a step-1 registry keeps its slots and allows the settling state", async () => {
    const db = new Kysely<SlotRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: new Sqlite(":memory:") }),
    });
    try {
      await slotRegistry000.up(db as Kysely<unknown>);
      await sql`INSERT INTO slot_scopes (scope_key, managed_host_scope, runner_namespace,
          runner_incarnation, state, created_at_ms, last_acquired_at_ms)
        VALUES ('scope-1', 'host', 'ns', 'inc', 'valid', 1, 1)`.execute(db);
      await sql`INSERT INTO slot_assignments (scope_key, slot_index, role, platform, generation,
          stable_device_id, device_name, requested_spec_json, state, exec_owner_daemon_id,
          exec_owner_pid, exec_session_uuid, updated_at_ms)
        VALUES ('scope-1', 0, 'app', 'android', 3, 'avd-1', 'avd-1', '{}', 'ready', 'd', 7,
          's1', 1)`.execute(db);

      await migrateSlotRegistry(db, ":memory:");

      const registry = new SqliteSlotRegistry(db, {
        timer: new FakeTimer(),
        isExecOwnerLive: () => false,
      });
      const key = { scopeKey: "scope-1", slotIndex: 0 };
      expect(await registry.getAssignment(key)).toMatchObject({
        generation: 3,
        stableDeviceId: "avd-1",
        state: "ready",
        execOwner: { daemonId: "d", pid: 7, sessionUuid: "s1", processGenerationToken: null },
        settler: null,
      });
      const settling = await registry.updateSlotState(
        key,
        { generation: 3, stableDeviceId: "avd-1" },
        "settling",
        { settler: { daemonId: "d", pid: 7 } },
      );
      expect(settling).toMatchObject({ kind: "updated", assignment: { state: "settling" } });
      // The one-device-one-slot index survived the rebuild.
      await expect(
        sql`INSERT INTO slot_assignments (scope_key, slot_index, role, platform, generation,
            stable_device_id, requested_spec_json, state, updated_at_ms)
          VALUES ('scope-1', 1, 'app', 'android', 0, 'avd-1', '{}', 'ready', 1)`.execute(db),
      ).rejects.toThrow();
    } finally {
      await db.destroy();
    }
  });
});
