// The file-backed opener (openSqliteBindingRegistry) differs only by connection PRAGMAs and is
// covered by sqliteBindingRegistry.integration.test.ts; this unit test pins data preservation
// across the migration.
import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../../../src/db/bunSqliteDialect";
import { computeBindingResourceUsage } from "../../../../src/daemon/sessionBroker/provisioning/resourceBudget";
import {
  computeBindingScopeKey,
  type BindingRegistry,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { migrateBindingRegistry } from "../../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import {
  SqliteBindingRegistry,
  type BindingRegistryDatabase,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";

const previousMigrations = [
  "2026_10_09_000_slot_registry",
  "2026_10_09_001_slot_owner_fencing",
  "2026_10_09_002_slot_journal",
  "2026_10_10_003_free_device_stop_state",
  "2026_10_12_004_free_device_deletion",
];
const currentMigrations = [
  ...previousMigrations,
  "2026_10_13_005_free_device_deletion_failed_deletes",
  "2026_10_15_006_session_broker",
  "2026_10_15_007_session_broker_failure_retryable",
];
const domainTables = ["slot_assignments", "slot_scopes", "slot_journal", "slot_free_devices"];
const owner = {
  daemonId: "fixture-daemon-1",
  pid: 4242,
  processGenerationToken: "fixture-process-1",
};
const scopeKey = computeBindingScopeKey({
  managedHostScope: "fixture-host",
  runnerNamespace: "fixture-runner",
  runnerIncarnation: "fixture-incarnation-1",
});

function migrationRows(db: Database) {
  return db
    .query<{ name: string; timestamp: string }, []>("SELECT * FROM kysely_migration ORDER BY name")
    .all();
}

function readRows(db: Database, table: string, columns = "*") {
  return db
    .query<Record<string, string | number | null>, []>(
      `SELECT ${columns} FROM ${table} ORDER BY 1, 2`,
    )
    .all();
}

async function expectOwnersAndBudget(registry: BindingRegistry) {
  const assignments = await registry.listAssignments(scopeKey);
  expect(assignments).toHaveLength(2);
  expect(assignments.map((row) => [row.stableDeviceId, row.state, row.execOwner])).toEqual([
    ["fixture-avd-a", "ready", { ...owner, sessionUuid: "fixture-session-1" }],
    ["fixture-avd-b", "ready", null],
  ]);
  const snapshot = await registry.snapshotBindingResources();
  expect(snapshot.openJournal).toMatchObject([
    {
      kind: "release",
      phase: "intent",
      bindingIndex: 1,
      binding: { generation: 1, stableDeviceId: "fixture-avd-b" },
    },
  ]);
  expect(snapshot.openJournal).toHaveLength(1);
  expect(computeBindingResourceUsage(snapshot)).toEqual({
    total: 2,
    active: 1,
    assignedIdle: 1,
    cached: 0,
    preparing: 0,
    deleting: 0,
    orphaned: 0,
  });
}

describe("upgrade from a captured schema-004 registry", () => {
  let fixtureSql: string;
  let migratedSnapshot: Uint8Array;
  let legacyRows: { table: string; rows: ReturnType<typeof readRows> }[];
  beforeAll(async () => {
    fixtureSql = await Bun.file(
      new URL("../../../fixtures/managed-slots/registry-schema-004.sql", import.meta.url),
    ).text();
    const db = new Database(":memory:");
    const kysely = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: db }),
    });
    try {
      db.exec(fixtureSql);
      legacyRows = domainTables.map((table) => ({ table, rows: readRows(db, table) }));
      await migrateBindingRegistry(kysely, ":memory:");
      // Serialize before destroy closes the connection; tests only read these shared bytes.
      migratedSnapshot = db.serialize();
    } finally {
      await kysely.destroy();
    }
  });

  test("migration keeps every legacy row and records 005", async () => {
    const db = new Database(":memory:");
    const kysely = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: db }),
    });
    try {
      db.exec(fixtureSql);
      expect(migrationRows(db).map((row) => row.name)).toEqual(previousMigrations);
      const before = domainTables.map((table) => ({ table, rows: readRows(db, table) }));
      expect(before).toEqual(legacyRows);
      expect(before.map(({ rows }) => rows.length)).toEqual([2, 2, 5, 2]);
      expect(before[2].rows.filter((row) => row.phase === "committed")).toHaveLength(4);
      expect(before[3].rows[0]).not.toHaveProperty("deletion_failed_deletes");
      await migrateBindingRegistry(kysely, ":memory:");
      const migrated = migrationRows(db);
      expect(migrated.map((row) => row.name)).toEqual(currentMigrations);
      expect(migrated.slice(0, 5)).toEqual(
        previousMigrations.map((name) => ({
          name,
          timestamp: "2025-10-09T08:53:20.000Z",
        })),
      );
      for (const { table, rows } of legacyRows) {
        // Compare raw SQL values: JSON and all legacy fields must survive byte-for-byte.
        expect(readRows(db, table, Object.keys(rows[0]).join(", "))).toEqual(rows);
      }
      expect(db.query("SELECT deletion_failed_deletes FROM slot_free_devices").values()).toEqual([
        [null],
        [null],
      ]);
    } finally {
      await kysely.destroy();
    }
  });

  test("current registry reads owners, deletion marker and budget charges from the migrated database", async () => {
    const db = Database.deserialize(migratedSnapshot);
    const kysely = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: db }),
    });
    try {
      const timer = new FakeTimer();
      timer.setCurrentTime(1_760_000_000_100);
      const registry = new SqliteBindingRegistry(kysely, {
        timer,
        isExecOwnerLive: (candidate: typeof owner) =>
          candidate.daemonId === owner.daemonId &&
          candidate.pid === owner.pid &&
          candidate.processGenerationToken === owner.processGenerationToken,
      });
      await expectOwnersAndBudget(registry);
    } finally {
      await kysely.destroy();
    }
  });

  test("a restart re-opens the migrated registry without migrating again", async () => {
    // A fresh handle, Kysely and registry retain no in-process registry state.
    const db = Database.deserialize(migratedSnapshot);
    const kysely = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: db }),
    });
    try {
      const migrated = migrationRows(db);
      const before = domainTables.map((table) => readRows(db, table));
      await migrateBindingRegistry(kysely, ":memory:");
      // Unchanged migration records and complete rows prove the second open is a no-op.
      expect(migrationRows(db)).toEqual(migrated);
      expect(domainTables.map((table) => readRows(db, table))).toEqual(before);
      const timer = new FakeTimer();
      timer.setCurrentTime(1_760_000_000_100);
      const registry = new SqliteBindingRegistry(kysely, {
        timer,
        isExecOwnerLive: (candidate: typeof owner) =>
          candidate.daemonId === owner.daemonId &&
          candidate.pid === owner.pid &&
          candidate.processGenerationToken === owner.processGenerationToken,
      });
      await expectOwnersAndBudget(registry);
    } finally {
      await kysely.destroy();
    }
  });
});
