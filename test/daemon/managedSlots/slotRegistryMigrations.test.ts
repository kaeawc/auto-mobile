import { describe, expect, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../../src/db/bunSqliteDialect";
import * as slotRegistry000 from "../../../src/daemon/managedSlots/migrations/2026_10_09_000_slot_registry";
import { migrateSlotRegistry } from "../../../src/daemon/managedSlots/slotRegistryMigrations";
import {
  SqliteSlotRegistry,
  type SlotRegistryDatabase,
} from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("slot registry migrations", () => {
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
