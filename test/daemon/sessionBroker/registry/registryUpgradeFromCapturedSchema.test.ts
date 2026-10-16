// Captured schema stays immutable. Upgrade snapshots below exercise the production retirement store.
import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { BunSqliteDialect } from "../../../../src/db/bunSqliteDialect";
import { ActionableError } from "../../../../src/models/ActionableError";
import { SESSION_BROKER_SCOPE } from "../../../../src/daemon/sessionBroker/hostConfig";
import { BROKER_BINDING_ROLE } from "../../../../src/daemon/sessionBroker/persistedIdentity";
import { computeBindingScopeKey } from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import {
  assertBindingRegistryCurrent,
  BindingRegistryUpgradePendingError,
  migrateBindingRegistry,
  bindingRegistryMigrationProvider,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import {
  LegacySlotDeviceRetirement,
  prepareBindingRegistryForStartup,
  type LegacySlotDeviceStopper,
  type LegacySlotDeviceTarget,
} from "../../../../src/daemon/sessionBroker/registry/legacySlotDeviceRetirement";
import { SqliteLegacySlotRetirementStore } from "../../../../src/daemon/sessionBroker/registry/sqliteLegacySlotRetirementStore";
import * as retirement008 from "../../../../src/daemon/sessionBroker/registry/migrations/2026_10_16_008_retire_slot_features";
import type { DeviceInfo } from "../../../../src/models/DeviceInfo";
import { FakeTimer } from "../../../fakes/FakeTimer";

const KEY = "2026_10_16_008_retire_slot_features";
const BROKER_SCOPE = computeBindingScopeKey(SESSION_BROKER_SCOPE);
let captured: Uint8Array;
let at007: Uint8Array;

function harness(bytes: Uint8Array = captured) {
  const sqlite = Database.deserialize(bytes);
  const db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: sqlite }) });
  return { sqlite, db };
}
function rows(sqlite: Database, table: string) {
  return sqlite.query(`SELECT * FROM ${table} ORDER BY rowid`).all();
}
function domain(sqlite: Database) {
  return [
    "slot_assignments",
    "slot_journal",
    "slot_scopes",
    "slot_free_devices",
    "session_broker_requests",
    "session_broker_resources",
    "kysely_migration",
  ].map((table) => rows(sqlite, table));
}
function applied(sqlite: Database) {
  return sqlite.query("SELECT * FROM kysely_migration WHERE name = ?").get(KEY) !== null;
}
function clean(sqlite: Database) {
  expect(rows(sqlite, "slot_assignments")).toEqual([]);
  expect(rows(sqlite, "slot_journal")).toEqual([]);
  expect(rows(sqlite, "slot_scopes")).toEqual([]);
  expect(
    sqlite.query("SELECT name FROM sqlite_master WHERE name = 'slot_free_devices'").get(),
  ).toBeNull();
  expect(applied(sqlite)).toBe(true);
}
class FakeStopper implements LegacySlotDeviceStopper {
  readonly stopped: string[] = [];
  readonly inspected: LegacySlotDeviceTarget[] = [];
  fail = false;
  unconfirmed = false;
  hang = false;
  running = true;
  product = true;
  absent = false;
  failOnStop = 0;
  readonly stoppedNames = new Set<string>();
  async inspect(target: LegacySlotDeviceTarget): Promise<DeviceInfo | undefined> {
    this.inspected.push(target);
    if (this.absent) {
      return undefined;
    }
    return {
      platform: target.platform,
      name: this.product ? (target.name ?? `amslot-${target.stableId}`) : "Personal phone",
      deviceId: target.stableId ?? "new-id",
      isRunning:
        this.running &&
        !this.stoppedNames.has(
          this.product ? (target.name ?? `amslot-${target.stableId}`) : "Personal phone",
        ),
    };
  }
  async stop(device: DeviceInfo): Promise<void> {
    this.stopped.push(device.name);
    if (this.hang) {
      await new Promise<void>(() => {});
    }
    if (this.fail || this.stopped.length === this.failOnStop) {
      throw new Error("native shutdown failed");
    }
    if (!this.unconfirmed) {
      this.stoppedNames.add(device.name);
    }
  }
}
function retirement(
  db: Kysely<unknown>,
  options: { devices?: FakeStopper; live?: boolean; timer?: FakeTimer } = {},
) {
  const devices = options.devices ?? new FakeStopper();
  const timer = options.timer ?? new FakeTimer();
  const warnings: unknown[][] = [];
  const step = new LegacySlotDeviceRetirement({
    devices,
    timer,
    isOwnerLive: () => options.live ?? false,
    warn: (...args) => {
      warnings.push(args);
    },
  });
  const store = new SqliteLegacySlotRetirementStore(db);
  return {
    devices,
    warnings,
    step,
    store,
    upgrade: () => migrateBindingRegistry(db, ":memory:", () => step.retire(store)),
  };
}

beforeAll(async () => {
  const sqlite = new Database(":memory:");
  const db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: sqlite }) });
  try {
    sqlite.exec(
      await Bun.file(
        new URL("../../../fixtures/managed-slots/registry-schema-004.sql", import.meta.url),
      ).text(),
    );
    captured = sqlite.serialize();
    expect(
      (
        await new Migrator({ db, provider: bindingRegistryMigrationProvider }).migrateTo(
          "2026_10_15_007_session_broker_failure_retryable",
        )
      ).error,
    ).toBeUndefined();
    at007 = sqlite.serialize();
  } finally {
    await db.destroy();
  }
});

describe("retiring the captured slot registry", () => {
  test("stopped legacy devices retire before upgrading captured 004; a second run does no native work", async () => {
    const { sqlite, db } = harness();
    try {
      const devices = new FakeStopper();
      devices.running = false;
      const run = retirement(db, { devices });
      await run.upgrade();
      clean(sqlite);
      expect(devices.stopped).toEqual([]);
      const count = devices.inspected.length;
      const migrated = rows(sqlite, "kysely_migration");
      await run.upgrade();
      expect(rows(sqlite, "kysely_migration")).toEqual(migrated);
      expect(devices.inspected).toHaveLength(count);
      const original = Database.deserialize(captured);
      try {
        expect(migrated.slice(0, 5)).toEqual(rows(original, "kysely_migration"));
      } finally {
        original.close();
      }
    } finally {
      await db.destroy();
    }
  });
  test("running legacy product device stops before rows disappear and 008 applies", async () => {
    const { sqlite, db } = harness();
    try {
      const run = retirement(db);
      await run.upgrade();
      expect(new Set(run.devices.stopped)).toEqual(
        new Set([
          "amslot-fixture-avd-a",
          "amslot-fixture-avd-b",
          "amslot-fixture-avd-cached",
          "amslot-fixture-avd-deleting",
        ]),
      );
      clean(sqlite);
    } finally {
      await db.destroy();
    }
  });
  test("stop failure preserves every row and migration record, then retry converges", async () => {
    const { sqlite, db } = harness(at007);
    try {
      const before = domain(sqlite);
      const run = retirement(db);
      run.devices.fail = true;
      await expect(run.upgrade()).rejects.toBeInstanceOf(ActionableError);
      expect(domain(sqlite)).toEqual(before);
      expect(applied(sqlite)).toBe(false);
      expect(run.warnings[0][0]).toContain("native shutdown failed");
      run.devices.fail = false;
      await run.upgrade();
      clean(sqlite);
    } finally {
      await db.destroy();
    }
  });
  test("failure after an earlier successful stop keeps all rows; retry skips the stopped image", async () => {
    const { sqlite, db } = harness(at007);
    try {
      const before = domain(sqlite);
      const run = retirement(db);
      run.devices.failOnStop = 2;
      await expect(run.upgrade()).rejects.toThrow("native shutdown failed");
      expect(domain(sqlite)).toEqual(before);
      expect(run.devices.stoppedNames.has("amslot-fixture-avd-a")).toBe(true);
      run.devices.failOnStop = 0;
      await run.upgrade();
      clean(sqlite);
      expect(run.devices.stopped.filter((name) => name === "amslot-fixture-avd-a")).toHaveLength(1);
    } finally {
      await db.destroy();
    }
  });
  test("live execution owner leaves all devices and rows untouched", async () => {
    const { sqlite, db } = harness(at007);
    try {
      const before = domain(sqlite);
      const run = retirement(db, { live: true });
      await expect(run.upgrade()).rejects.toThrow("live execution");
      expect(run.devices.inspected).toEqual([]);
      expect(run.devices.stopped).toEqual([]);
      expect(domain(sqlite)).toEqual(before);
    } finally {
      await db.destroy();
    }
  });
  test("a shared stable id with a non-product name is never stopped or forgotten", async () => {
    const { sqlite, db } = harness(at007);
    try {
      const before = domain(sqlite);
      const run = retirement(db);
      run.devices.product = false;
      await expect(run.upgrade()).rejects.toThrow("non-product");
      expect(run.devices.stopped).toEqual([]);
      expect(domain(sqlite)).toEqual(before);
    } finally {
      await db.destroy();
    }
  });
  test("unconfirmed shutdown keeps rows for retry", async () => {
    const { sqlite, db } = harness(at007);
    try {
      const before = domain(sqlite);
      const run = retirement(db);
      run.devices.unconfirmed = true;
      await expect(run.upgrade()).rejects.toThrow("unconfirmed");
      expect(domain(sqlite)).toEqual(before);
    } finally {
      await db.destroy();
    }
  });
  test("FakeTimer bounds a stalled shutdown and rolls back before returning", async () => {
    const { sqlite, db } = harness(at007);
    try {
      const before = domain(sqlite);
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const run = retirement(db, { timer });
      run.devices.hang = true;
      await expect(run.upgrade()).rejects.toThrow("timed out");
      expect(domain(sqlite)).toEqual(before);
      expect(applied(sqlite)).toBe(false);
    } finally {
      await db.destroy();
    }
  });
  test("a late discovery result after timeout cannot stop a device or remove rows", async () => {
    const { sqlite, db } = harness(at007);
    let complete!: (device: DeviceInfo) => void;
    class DelayedStopper extends FakeStopper {
      override async inspect(): Promise<DeviceInfo> {
        return new Promise<DeviceInfo>((resolve) => {
          complete = resolve;
        });
      }
    }
    try {
      const before = domain(sqlite);
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const devices = new DelayedStopper();
      const run = retirement(db, { devices, timer });
      await expect(run.upgrade()).rejects.toThrow("timed out");
      complete({
        platform: "android",
        name: "amslot-late",
        deviceId: "emulator-5554",
        isRunning: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(devices.stopped).toEqual([]);
      expect(domain(sqlite)).toEqual(before);
    } finally {
      await db.destroy();
    }
  });
  test.each(["journal", "deletion", "settler"])(
    "live %s owner prevents all native work",
    async (kind) => {
      const { sqlite, db } = harness(at007);
      try {
        sqlite.exec(
          "UPDATE slot_assignments SET exec_owner_pid = NULL; UPDATE slot_journal SET owner_pid = 7; UPDATE slot_free_devices SET deletion_owner_pid = NULL",
        );
        if (kind === "journal") {
          sqlite.exec("UPDATE slot_journal SET owner_pid = 4242 WHERE phase = 'intent'");
        }
        if (kind === "deletion") {
          sqlite.exec("UPDATE slot_free_devices SET deletion_owner_pid = 4242");
        }
        if (kind === "settler") {
          sqlite.exec("UPDATE slot_assignments SET settler_pid = 4242");
        }
        const before = domain(sqlite);
        const devices = new FakeStopper();
        const timer = new FakeTimer();
        const step = new LegacySlotDeviceRetirement({
          timer,
          devices,
          isOwnerLive: (owner) => owner.pid === 4242,
          warn: () => {},
        });
        await expect(
          migrateBindingRegistry(db, ":memory:", () =>
            step.retire(new SqliteLegacySlotRetirementStore(db)),
          ),
        ).rejects.toThrow("live execution");
        expect(devices.stopped).toEqual([]);
        expect(domain(sqlite)).toEqual(before);
      } finally {
        await db.destroy();
      }
    },
  );
  test("missing native images are confirmed absent, so retirement can finish", async () => {
    const { sqlite, db } = harness();
    try {
      const run = retirement(db);
      run.devices.absent = true;
      await run.upgrade();
      clean(sqlite);
      expect(run.devices.stopped).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  test.each(["assignment", "journal", "free"])(
    "008 itself refuses an unsafe %s before any change",
    async (kind) => {
      const { sqlite, db } = harness(at007);
      try {
        if (kind !== "assignment") {
          sqlite.exec("UPDATE slot_assignments SET stable_device_id = NULL, device_name = NULL");
        }
        if (kind !== "journal") {
          sqlite.exec("UPDATE slot_journal SET phase = 'committed'");
        }
        if (kind !== "free") {
          sqlite.exec("DELETE FROM slot_free_devices");
        }
        const before = domain(sqlite);
        await expect(retirement008.up(db)).rejects.toThrow(
          "Legacy slot devices must be retired first",
        );
        expect(domain(sqlite)).toEqual(before);
      } finally {
        await db.destroy();
      }
    },
  );
  test("008 alone removes safe unbound rows and is irreversible", async () => {
    const { sqlite, db } = harness(at007);
    try {
      sqlite.exec(
        "UPDATE slot_assignments SET stable_device_id = NULL, device_name = NULL; UPDATE slot_journal SET phase = 'committed'; DELETE FROM slot_free_devices",
      );
      await migrateBindingRegistry(db, ":memory:");
      clean(sqlite);
      await expect(retirement008.down()).rejects.toThrow("irreversible");
    } finally {
      await db.destroy();
    }
  });
  test.each(["amslot-name-only", "Personal phone"])(
    "name-only legacy assignment %s cannot bypass retirement",
    async (name) => {
      const { sqlite, db } = harness(at007);
      try {
        sqlite.exec(
          "UPDATE slot_assignments SET stable_device_id = NULL, device_name = NULL; DELETE FROM slot_free_devices; UPDATE slot_journal SET phase = 'committed'",
        );
        sqlite.run("UPDATE slot_assignments SET device_name = ? WHERE slot_index = 0", [name]);
        const before = domain(sqlite);
        await expect(retirement008.up(db)).rejects.toThrow("must be retired first");
        const run = retirement(db);
        if (name.startsWith("amslot-")) {
          await run.upgrade();
          expect(run.devices.inspected[0]).toMatchObject({ stableId: null, name });
          expect(run.devices.stopped).toEqual([name]);
          clean(sqlite);
        } else {
          await expect(run.upgrade()).rejects.toThrow("non-product");
          expect(run.devices.stopped).toEqual([]);
          expect(domain(sqlite)).toEqual(before);
        }
      } finally {
        await db.destroy();
      }
    },
  );

  test("native inspection and stop run without a transaction; changed rows prevent deletion", async () => {
    const { sqlite, db } = harness(at007);
    try {
      const devices = new FakeStopper();
      const inspect = devices.inspect.bind(devices);
      const stop = devices.stop.bind(devices);
      let nativeCalls = 0;
      const assertOutsideTransaction = () => {
        // A fake peer write via BEGIN would fail if retirement still held a transaction.
        sqlite.exec("BEGIN IMMEDIATE; ROLLBACK");
        nativeCalls++;
      };
      devices.inspect = async (target) => {
        assertOutsideTransaction();
        return inspect(target);
      };
      devices.stop = async (device) => {
        assertOutsideTransaction();
        await stop(device);
        sqlite.exec("UPDATE slot_assignments SET generation = generation + 1");
      };
      const run = retirement(db, { devices });
      await expect(run.upgrade()).rejects.toThrow("rows changed");
      expect(nativeCalls).toBeGreaterThan(0);
      expect(rows(sqlite, "slot_assignments")).toHaveLength(2);
      expect(rows(sqlite, "slot_free_devices")).toHaveLength(2);
      expect(applied(sqlite)).toBe(false);
      await run.upgrade();
      clean(sqlite);
    } finally {
      await db.destroy();
    }
  });

  test("an exclusion reader never migrates pending 008, then observes a completed retirement", async () => {
    const { sqlite, db } = harness(at007);
    try {
      const before = domain(sqlite);
      await expect(assertBindingRegistryCurrent(db, ":memory:")).rejects.toBeInstanceOf(
        BindingRegistryUpgradePendingError,
      );
      expect(domain(sqlite)).toEqual(before);
      await retirement(db).upgrade();
      await assertBindingRegistryCurrent(db, ":memory:");
      clean(sqlite);
    } finally {
      await db.destroy();
    }
  });

  test("fresh DB migrates without any native calls", async () => {
    const sqlite = new Database(":memory:");
    const db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: sqlite }) });
    try {
      const run = retirement(db);
      await run.upgrade();
      clean(sqlite);
      expect(run.devices.inspected).toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});

function seedBroker(sqlite: Database) {
  sqlite.run(
    "INSERT INTO slot_scopes SELECT ?, managed_host_scope, 'session-broker', runner_incarnation, state, invalidation_reason, created_at_ms, last_acquired_at_ms, invalidating_at_ms, invalidated_at_ms, last_released_at_ms FROM slot_scopes WHERE state = 'valid'",
    [BROKER_SCOPE],
  );
  sqlite.run(
    "INSERT INTO slot_assignments SELECT ?, slot_index, ?, platform, generation, 'ambroker-device-' || slot_index, 'ambroker-device-' || slot_index, requested_spec_json, resolved_spec_json, spec_fingerprint, state, exec_owner_daemon_id, exec_owner_pid, exec_owner_process_token, exec_session_uuid, settler_daemon_id, settler_pid, settler_process_token, updated_at_ms FROM slot_assignments",
    [BROKER_SCOPE, BROKER_BINDING_ROLE],
  );
  sqlite.run(
    "INSERT INTO slot_journal SELECT id + 100, ?, slot_index, kind, phase, platform, from_generation, to_generation, binding_generation, binding_stable_device_id, target_json, owner_daemon_id, owner_pid, owner_process_token, attempts, last_error, next_attempt_at_ms, created_at_ms, updated_at_ms FROM slot_journal WHERE scope_key = (SELECT scope_key FROM slot_scopes WHERE state = 'valid' AND scope_key <> ?)",
    [BROKER_SCOPE, BROKER_SCOPE],
  );
  sqlite.exec(`INSERT INTO session_broker_requests VALUES ('receipt', 'fingerprint', '{ "exact": true }', '{}', 'active', 'r', 's', NULL, NULL, NULL);
    INSERT INTO session_broker_resources VALUES (1, 'r', '${BROKER_SCOPE}', '{ "profile": true }', 'active', 'receipt', 2, 7)`);
}
function brokerRows(sqlite: Database) {
  return ["slot_scopes", "slot_assignments", "slot_journal"]
    .map((table) =>
      sqlite.query(`SELECT * FROM ${table} WHERE scope_key = ? ORDER BY rowid`).all(BROKER_SCOPE),
    )
    .concat([rows(sqlite, "session_broker_requests"), rows(sqlite, "session_broker_resources")]);
}
test.each([false, true])(
  "broker bytes survive retirement (broker-only: %s)",
  async (onlyBroker) => {
    const { sqlite, db } = harness(at007);
    try {
      seedBroker(sqlite);
      if (onlyBroker) {
        sqlite.run("DELETE FROM slot_journal WHERE scope_key <> ?", [BROKER_SCOPE]);
        sqlite.run("DELETE FROM slot_assignments WHERE scope_key <> ?", [BROKER_SCOPE]);
        sqlite.run("DELETE FROM slot_scopes WHERE scope_key <> ?", [BROKER_SCOPE]);
        sqlite.exec("DELETE FROM slot_free_devices");
      }
      const before = brokerRows(sqlite);
      const run = retirement(db);
      if (onlyBroker) {
        await migrateBindingRegistry(db, ":memory:");
      } else {
        await run.upgrade();
      }
      expect(brokerRows(sqlite)).toEqual(before);
      expect(rows(sqlite, "slot_assignments")).toHaveLength(2);
      expect(rows(sqlite, "slot_journal")).toHaveLength(3);
      expect(rows(sqlite, "slot_scopes")).toHaveLength(1);
      expect(applied(sqlite)).toBe(true);
      expect(
        sqlite.query("SELECT name FROM sqlite_master WHERE name = 'slot_free_devices'").get(),
      ).toBeNull();
    } finally {
      await db.destroy();
    }
  },
);
test.each([false, true])(
  "startup failure policy (broker configured: %s)",
  async (brokerConfigured) => {
    const warnings: unknown[][] = [];
    const operation = prepareBindingRegistryForStartup({
      brokerConfigured,
      registryExists: true,
      open: async () => {
        throw new Error("retirement failed");
      },
      warn: (...args) => {
        warnings.push(args);
      },
    });
    if (brokerConfigured) {
      await expect(operation).rejects.toBeInstanceOf(ActionableError);
    } else {
      await operation;
    }
    expect(warnings[0][0]).toContain("retirement failed");
  },
);

test("008 retains the empty private broker scope byte-for-byte", async () => {
  const { sqlite, db } = harness(at007);
  try {
    sqlite.exec(
      "UPDATE slot_assignments SET stable_device_id = NULL, device_name = NULL; UPDATE slot_journal SET phase = 'committed'; DELETE FROM slot_free_devices",
    );
    sqlite.run("UPDATE slot_scopes SET scope_key = ? WHERE state = 'valid'", [BROKER_SCOPE]);
    const before = sqlite.query("SELECT * FROM slot_scopes WHERE scope_key = ?").get(BROKER_SCOPE);
    await migrateBindingRegistry(db, ":memory:");
    expect(rows(sqlite, "slot_scopes")).toEqual([before]);
  } finally {
    await db.destroy();
  }
});

test("duplicate legacy free row cannot authorize stopping a surviving broker device", async () => {
  const { sqlite, db } = harness(at007);
  try {
    seedBroker(sqlite);
    sqlite.exec(
      "UPDATE slot_free_devices SET stable_device_id = 'ambroker-device-0' WHERE stable_device_id = 'fixture-avd-cached'",
    );
    const before = domain(sqlite);
    const run = retirement(db);
    await expect(run.upgrade()).rejects.toThrow("overlaps a broker device");
    expect(run.devices.stopped).toEqual([]);
    expect(domain(sqlite)).toEqual(before);
  } finally {
    await db.destroy();
  }
});

test("owner liveness is rechecked after discovery, immediately before stopping", async () => {
  const { sqlite, db } = harness(at007);
  try {
    const before = domain(sqlite);
    const devices = new FakeStopper();
    let discovered = false;
    const inspect = devices.inspect.bind(devices);
    devices.inspect = async (target) => {
      const result = await inspect(target);
      discovered = true;
      return result;
    };
    const step = new LegacySlotDeviceRetirement({
      devices,
      timer: new FakeTimer(),
      isOwnerLive: () => discovered,
      warn: () => {},
    });
    await expect(
      migrateBindingRegistry(db, ":memory:", () =>
        step.retire(new SqliteLegacySlotRetirementStore(db)),
      ),
    ).rejects.toThrow("live execution");
    expect(devices.stopped).toEqual([]);
    expect(domain(sqlite)).toEqual(before);
  } finally {
    await db.destroy();
  }
});

test("retirement commits legacy scopes, assignments, journals and free rows together before migration", async () => {
  const { sqlite, db } = harness();
  try {
    const run = retirement(db);
    run.devices.running = false;
    await run.step.retire(run.store);
    for (const table of ["slot_scopes", "slot_assignments", "slot_journal", "slot_free_devices"]) {
      expect(rows(sqlite, table)).toEqual([]);
    }
    expect(applied(sqlite)).toBe(false);
    await migrateBindingRegistry(db, ":memory:");
    clean(sqlite);
  } finally {
    await db.destroy();
  }
});
