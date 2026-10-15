import { describe, expect, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { BunSqliteDialect } from "../../../../src/db/bunSqliteDialect";
import * as freeStop003 from "../../../../src/daemon/sessionBroker/registry/migrations/2026_10_10_003_free_device_stop_state";
import * as freeDeletion004 from "../../../../src/daemon/sessionBroker/registry/migrations/2026_10_12_004_free_device_deletion";
import * as bindingRegistry000 from "../../../../src/daemon/sessionBroker/registry/migrations/2026_10_09_000_binding_registry";
import {
  migrateBindingRegistry,
  bindingRegistryMigrationProvider,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import {
  SqliteBindingRegistry,
  type BindingRegistryDatabase,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";

describe("binding registry migrations", () => {
  test("the public pending-migration probe never creates bookkeeping tables", async () => {
    const db = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: new Sqlite(":memory:") }),
    });
    try {
      const migrations = await new Migrator({
        db,
        provider: bindingRegistryMigrationProvider,
      }).getMigrations();
      expect(migrations).toHaveLength(8);
      expect(migrations.every((migration) => migration.executedAt === undefined)).toBe(true);
      expect(await db.introspection.getTables({ withInternalKyselyTables: true })).toEqual([]);
      await migrateBindingRegistry(db, ":memory:");
      const migrated = await new Migrator({
        db,
        provider: bindingRegistryMigrationProvider,
      }).getMigrations();
      expect(migrated.every((migration) => migration.executedAt !== undefined)).toBe(true);
    } finally {
      await db.destroy();
    }
  });
  test("migration 007 preserves legacy failure receipts with nonretryable null defaults", async () => {
    const db = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: new Sqlite(":memory:") }),
    });
    try {
      const migrator = new Migrator({ db, provider: bindingRegistryMigrationProvider });
      expect((await migrator.migrateTo("2026_10_15_006_session_broker")).error).toBeUndefined();
      await sql`INSERT INTO session_broker_requests (request_id, fingerprint, parameters_json, owner_json, state, error, error_code)
        VALUES ('legacy', 'fingerprint', '{}', '{"daemonId":"d","pid":1}', 'failed', 'native failure', 'timeout')`.execute(
        db,
      );
      await migrateBindingRegistry(db, ":memory:");
      expect(
        (await db.selectFrom("session_broker_requests").selectAll().executeTakeFirstOrThrow())
          .retryable,
      ).toBeNull();
      const registry = new SqliteBindingRegistry(db, { timer: new FakeTimer() });
      expect(await registry.sessionBrokerStore("scope").getRequest("legacy")).toMatchObject({
        errorCode: "timeout",
        error: "native failure",
        retryable: false,
      });
      await expect(
        sql`UPDATE session_broker_requests SET retryable = 2`.execute(db),
      ).rejects.toThrow("CHECK");
      await sql`UPDATE session_broker_requests SET retryable = 1`.execute(db);
      expect(await registry.sessionBrokerStore("scope").getRequest("legacy")).toMatchObject({
        retryable: true,
      });
    } finally {
      await db.destroy();
    }
  });

  test("migration 004 preserves stopped images, defaults markers to null and preserves the state CHECK", async () => {
    const db = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: new Sqlite(":memory:") }),
    });
    try {
      await bindingRegistry000.up(db as Kysely<unknown>);
      await freeStop003.up(db as Kysely<unknown>);
      await sql`INSERT INTO slot_free_devices (platform, stable_device_id, from_scope_key, freed_at_ms, state)
        VALUES ('android', 'amslot-old', 'scope', 12, 'stopped')`.execute(db);
      await freeDeletion004.up(db as Kysely<unknown>);
      expect(await historicalFreeRows(db)).toMatchObject([
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
      expect(await historicalFreeRows(db)).toMatchObject([{ state: "stopped", deletion: null }]);
    } finally {
      await db.destroy();
    }
  });

  test("migration 005 reads legacy marked rows with zero failed deletes", async () => {
    const db = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: new Sqlite(":memory:") }),
    });
    try {
      const migrator = new Migrator({ db, provider: bindingRegistryMigrationProvider });
      expect(
        (await migrator.migrateTo("2026_10_12_004_free_device_deletion")).error,
      ).toBeUndefined();
      await sql`INSERT INTO slot_free_devices (platform, stable_device_id, from_scope_key, freed_at_ms,
        state, deletion_owner_daemon_id, deletion_owner_pid, deletion_started_at_ms,
        deletion_attempts, deletion_last_error, deletion_next_attempt_at_ms)
        VALUES ('android', 'amslot-legacy', 'scope', 12, 'free', 'old', 7, 12, 10, 'blocked', 99)`.execute(
        db,
      );
      await migrateBindingRegistry(db, ":memory:");
      expect(
        (await historicalFreeRows(db)).filter((row) => row.deletion !== null)[0].deletion,
      ).toMatchObject({
        attempts: 10,
        failedDeletes: 0,
        lastError: "blocked",
        nextAttemptAtMs: 99,
      });
      expect(
        (await db.selectFrom("slot_free_devices").selectAll().executeTakeFirstOrThrow())
          .deletion_failed_deletes,
      ).toBeNull();
    } finally {
      await db.destroy();
    }
  });

  test("free rows from before migration 003 become state free with no claim, nothing lost (#11337)", async () => {
    const db = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: new Sqlite(":memory:") }),
    });
    try {
      await bindingRegistry000.up(db as Kysely<unknown>);
      await sql`INSERT INTO slot_free_devices (platform, stable_device_id, spec_fingerprint,
          from_scope_key, freed_at_ms)
        VALUES ('android', 'avd-1', 'fp-1', 'scope-old', 11),
               ('ios', 'UDID-2', NULL, 'scope-old', 22)`.execute(db);

      await migrateBindingRegistry(db, ":memory:");
      expect(await historicalFreeRows(db)).toEqual([
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

  test("upgrading a step-1 registry keeps its bindings and allows the settling state", async () => {
    const db = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: new Sqlite(":memory:") }),
    });
    try {
      await bindingRegistry000.up(db as Kysely<unknown>);
      await sql`INSERT INTO slot_scopes (scope_key, managed_host_scope, runner_namespace,
          runner_incarnation, state, created_at_ms, last_acquired_at_ms)
        VALUES ('scope-1', 'host', 'ns', 'inc', 'valid', 1, 1)`.execute(db);
      await sql`INSERT INTO slot_assignments (scope_key, slot_index, role, platform, generation,
          stable_device_id, device_name, requested_spec_json, state, exec_owner_daemon_id,
          exec_owner_pid, exec_session_uuid, updated_at_ms)
        VALUES ('scope-1', 0, 'app', 'android', 3, 'avd-1', 'avd-1', '{}', 'ready', 'd', 7,
          's1', 1)`.execute(db);

      await migrateBindingRegistry(db, ":memory:");

      const registry = new SqliteBindingRegistry(db, {
        timer: new FakeTimer(),
        isExecOwnerLive: () => false,
      });
      const key = { scopeKey: "scope-1", bindingIndex: 0 };
      expect(await registry.getAssignment(key)).toMatchObject({
        generation: 3,
        stableDeviceId: "avd-1",
        state: "ready",
        execOwner: { daemonId: "d", pid: 7, sessionUuid: "s1", processGenerationToken: null },
        settler: null,
      });
      const settling = await registry.updateBindingState(
        key,
        { generation: 3, stableDeviceId: "avd-1" },
        "settling",
        { settler: { daemonId: "d", pid: 7 } },
      );
      expect(settling).toMatchObject({ kind: "updated", assignment: { state: "settling" } });
      // The one-device-one-binding index survived the rebuild.
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

async function historicalFreeRows(db: Kysely<BindingRegistryDatabase>) {
  const rows = await db
    .selectFrom("slot_free_devices")
    .selectAll()
    .orderBy("freed_at_ms")
    .execute();
  return rows.map((row) => ({
    platform: row.platform,
    stableDeviceId: row.stable_device_id,
    specFingerprint: row.spec_fingerprint,
    fromScopeKey: row.from_scope_key,
    freedAtMs: row.freed_at_ms,
    state: row.state,
    stopClaimedBy: row.stop_claimed_by,
    stopClaimedAtMs: row.stop_claimed_at_ms,
    deletion:
      row.deletion_owner_pid === null
        ? null
        : {
            owner: {
              daemonId: row.deletion_owner_daemon_id,
              pid: row.deletion_owner_pid,
              processGenerationToken: row.deletion_owner_process_token,
            },
            startedAtMs: row.deletion_started_at_ms,
            attempts: row.deletion_attempts,
            failedDeletes: row.deletion_failed_deletes ?? 0,
            lastError: row.deletion_last_error,
            nextAttemptAtMs: row.deletion_next_attempt_at_ms,
          },
  }));
}
