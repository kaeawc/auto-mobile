import * as registryDatabase from "../../../../src/daemon/sessionBroker/registry/RegistryDatabase";
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { BunSqliteDialect } from "../../../../src/db/bunSqliteDialect";
import { NoOpMigrationLock } from "../../../../src/db/NoOpMigrationLock";
import { BrokerDeviceAcquisition } from "../../../../src/daemon/sessionBroker/provisioning/deviceAcquisition";
import * as refusals from "../../../../src/daemon/sessionBroker/provisioning/refusal";
import {
  assertBindingRegistryCurrent,
  migrateBindingRegistry,
  bindingRegistryMigrationProvider,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import {
  openSqliteBindingRegistry,
  type BindingRegistryDatabase,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { buildBrokerProvisionRequest } from "../../../helpers/provisionRequestFixture";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";

const FUTURE = "2026_10_17_009_future_schema";
const MIGRATION_004 = "2026_10_12_004_free_device_deletion";
const MIGRATION_005 = "2026_10_13_005_free_device_deletion_failed_deletes";

function database() {
  const sqlite = new Sqlite(":memory:");
  const db = new Kysely<BindingRegistryDatabase>({
    dialect: new BunSqliteDialect({ database: sqlite }),
  });
  return { sqlite, db };
}

function snapshot(sqlite: Sqlite) {
  const schema = sqlite.query("SELECT * FROM sqlite_master ORDER BY type, name").all();
  const tables = sqlite
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all();
  return {
    counters: sqlite.query("SELECT changes(), total_changes()").get(),
    schema,
    // Include Kysely bookkeeping, every domain table, and any future tables.
    tables: tables.map(({ name }) => ({
      name,
      rows: sqlite.query(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all(),
    })),
  };
}

function addFutureSchema(sqlite: Sqlite) {
  sqlite.run("INSERT INTO kysely_migration (name, timestamp) VALUES (?, ?)", [
    FUTURE,
    "2099-01-01T00:00:00.000Z",
  ]);
  sqlite.exec(
    "CREATE TABLE future_contract (value TEXT); INSERT INTO future_contract VALUES ('keep')",
  );
}

describe("binding registry schema compatibility", () => {
  const full = database();
  const partial = database();
  const known = database();
  const peer = database();

  beforeAll(async () => {
    for (const [harness, target] of [
      [full, "latest"],
      [partial, MIGRATION_004],
      [known, MIGRATION_004],
      [peer, MIGRATION_004],
    ] as const) {
      const migrator = new Migrator({ db: harness.db, provider: bindingRegistryMigrationProvider });
      const result =
        target === "latest" ? await migrator.migrateToLatest() : await migrator.migrateTo(target);
      expect(result.error).toBeUndefined();
      if (harness === known) {
        continue;
      }
      harness.sqlite.exec(`
        INSERT INTO slot_scopes (scope_key, managed_host_scope, runner_namespace, runner_incarnation,
          state, created_at_ms, last_acquired_at_ms) VALUES ('scope', 'host', 'runner', 'inc', 'valid', 1, 1);
        INSERT INTO slot_assignments (scope_key, slot_index, role, platform, generation,
          stable_device_id, requested_spec_json, state, updated_at_ms)
          VALUES ('scope', 0, 'app', 'android', 1, 'assigned', '{}', 'ready', 1);

      `);
    }
    partial.sqlite.exec(
      "INSERT INTO slot_free_devices (platform, stable_device_id, from_scope_key, freed_at_ms) VALUES ('android', 'free', 'scope', 1)",
    );
    addFutureSchema(full.sqlite);
    addFutureSchema(partial.sqlite);
  });

  afterAll(async () => {
    await Promise.all([full, partial, known, peer].map(({ db }) => db.destroy()));
  });

  test.each([
    ["fully migrated", full],
    ["partially migrated", partial],
  ] as const)("refuses a %s future registry without any write", async (_label, harness) => {
    const before = snapshot(harness.sqlite);
    const error = await migrateBindingRegistry(harness.db, ":memory:", undefined, {
      writerVersion: "test-writer",
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(snapshot(harness.sqlite)).toEqual(before);
    expect(error).toMatchObject({
      name: "BindingRegistrySchemaUnsupportedError",
      code: "registry_schema_unsupported",
      retryable: false,
      dbPath: ":memory:",
      unknownMigrations: [FUTURE],
    });
    expect(error).toBeInstanceOf(refusals.BindingRegistrySchemaUnsupportedError);
    if (harness === partial) {
      expect(
        harness.sqlite.query("SELECT name FROM kysely_migration WHERE name = ?").get(MIGRATION_005),
      ).toBeNull();
      expect(harness.sqlite.query("PRAGMA table_info(slot_free_devices)").all()).not.toContainEqual(
        expect.objectContaining({ name: "deletion_failed_deletes" }),
      );
    }
  });

  test.each([
    ["fully migrated", full],
    ["partially migrated", partial],
  ] as const)(
    "read-only compatibility check refuses a %s future registry without DDL, DML, or bookkeeping writes",
    async (_label, harness) => {
      const before = snapshot(harness.sqlite);
      await expect(assertBindingRegistryCurrent(harness.db, ":memory:")).rejects.toMatchObject({
        code: "registry_schema_unsupported",
        retryable: false,
        unknownMigrations: [FUTURE],
      });
      expect(snapshot(harness.sqlite)).toEqual(before);
    },
  );

  test.each([false, true])(
    "migrate:%s open preserves the typed refusal and never changes a future registry",
    async (migrate) => {
      const before = snapshot(full.sqlite);
      const statements: string[] = [];
      const create = spyOn(registryDatabase, "createRegistryDatabase").mockImplementation(() => ({
        prepare: (sql) => {
          statements.push(sql);
          return full.sqlite.prepare(sql);
        },
        exec: (sql) => {
          statements.push(sql);
          // Match the production registry handle, which suppresses close-time maintenance.
          if (sql !== "PRAGMA optimize;" && sql !== "PRAGMA wal_checkpoint(TRUNCATE);") {
            full.sqlite.exec(sql);
          }
        },
        // This borrowed in-memory fixture remains open for the surrounding schema assertions.
        close: () => {},
      }));
      try {
        await expect(
          openSqliteBindingRegistry({
            dbPath: ":memory:",
            migrate,
            timer: new FakeTimer(),
            writerVersion: "test-writer",
          }),
        ).rejects.toBeInstanceOf(refusals.BindingRegistrySchemaUnsupportedError);
        expect(snapshot(full.sqlite)).toEqual(before);
        expect(statements.every((sql) => /^(select|pragma)/i.test(sql.trim()))).toBe(true);
      } finally {
        create.mockRestore();
      }
    },
  );

  test("rechecks a peer's migration after acquiring the lock, before Kysely writes", async () => {
    let before: ReturnType<typeof snapshot> | undefined;
    const acquire = spyOn(NoOpMigrationLock.prototype, "acquire").mockImplementation(async () => {
      addFutureSchema(peer.sqlite);
      before = snapshot(peer.sqlite);
    });
    const release = spyOn(NoOpMigrationLock.prototype, "release");
    try {
      const error = await migrateBindingRegistry(peer.db, ":memory:", undefined, {
        writerVersion: "test-writer",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect<unknown>(snapshot(peer.sqlite)).toEqual(before);
      expect(error).toMatchObject({
        name: "BindingRegistrySchemaUnsupportedError",
        unknownMigrations: [FUTURE],
      });
      expect(error).toBeInstanceOf(refusals.BindingRegistrySchemaUnsupportedError);
    } finally {
      acquire.mockRestore();
      release.mockRestore();
    }
  });

  test("known executed names still migrate and a fresh in-memory registry opens", async () => {
    await migrateBindingRegistry(known.db, ":memory:", undefined, { writerVersion: "test-writer" });
    expect(
      known.sqlite.query("SELECT name FROM kysely_migration WHERE name = ?").get(MIGRATION_005),
    ).toEqual({ name: MIGRATION_005 });
    const before = snapshot(known.sqlite);
    await migrateBindingRegistry(known.db, ":memory:", undefined, { writerVersion: "test-writer" });
    expect(snapshot(known.sqlite)).toEqual(before);
    const registry = await openSqliteBindingRegistry({
      dbPath: ":memory:",
      timer: new FakeTimer(),
      writerVersion: "test-writer",
    });
    try {
      expect(await registry.snapshotManagedDevices()).toEqual([]);
    } finally {
      await registry.close();
    }
  });

  test("acquisition maps the schema refusal without registry, device, or session work", async () => {
    const timer = new FakeTimer();
    const registry = new FakeBindingRegistry(timer);
    const ensureScope = spyOn(registry, "ensureScope");
    const error = new refusals.BindingRegistrySchemaUnsupportedError(":memory:", [FUTURE]);
    expect(error.toPayload()).toEqual({
      code: "registry_schema_unsupported",
      retryable: false,
      dbPath: ":memory:",
      unknownMigrations: [FUTURE],
      writerVersions: {},
      remedy: error.remedy,
    });
    const open = mock(async () => {
      throw error;
    });
    const reconcile = mock(async () => {
      throw new Error("Unexpected device reconciliation");
    });
    const sessions = {
      claimLivenessOwnership: mock(async () => "claimed" as const),
      adoptManagedExecutionLivenessPolicy: mock(async () => {}),
      releaseSession: mock(async () => {}),
    };
    const owner = mock(() => ({ daemonId: "daemon", pid: 42 }));
    const acquisition = new BrokerDeviceAcquisition({
      registry: open,
      reconcile,
      sessions,
      owner,
      timer,
    });
    try {
      const result = await acquisition.acquire(
        buildBrokerProvisionRequest({
          contractVersion: 1,
          managedHostScope: "host",
          runnerNamespace: "runner",
          runnerIncarnation: "inc",
          localBindingCapacity: 1,
          requests: [
            { bindingIndex: 0, role: "app", platform: "ios", requestedSpec: { runtime: "ios-18" } },
          ],
        }),
        { livenessOwnerToken: "proxy-owner" },
      );
      expect(result).toMatchObject({
        outcome: "failed",
        bindings: [],
        failure: { code: "registry_schema_unsupported", retryable: false },
      });
      expect(result.failure?.message).toContain(FUTURE);
      expect(result.failure?.nextAction).toMatch(/upgrade.*every daemon.*build that migrated/i);
      expect(result.failure?.nextAction).toMatch(/restart.*older daemons/i);
      expect(result.failure?.nextAction).toContain("nothing was changed");
      expect(open).toHaveBeenCalledTimes(1);
      for (const call of [ensureScope, reconcile, owner, ...Object.values(sessions)]) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      acquisition.close();
      ensureScope.mockRestore();
    }
  });
});
